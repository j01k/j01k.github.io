(async () => {
  "use strict";

  const HOST_RE = /^stake\.(com|us)$/i;
  const SITE_ORIGIN = HOST_RE.test(location.hostname)
    ? location.origin
    : "https://stake.com";
  const GRAPHQL_URL = SITE_ORIGIN + "/_api/graphql";
  const ARCHIVE_URL_PREFIX = SITE_ORIGIN + "/_api/archive/";
  const ARCHIVE_PAGE_URL = SITE_ORIGIN + "/my-bets/archive";
  const PICKER_HANDLE_KEY = "__stakeArchivePickedDirectory";
  const PICKER_TRIED_KEY = "__stakeArchivePickerTried";
  const PAGE_SIZE = 10;
  const QUERY =
    "query BetArchive($offset: Int = 0, $limit: Int = 10) {\n" +
    "  user {\n" +
    "    id\n" +
    "    betArchiveList(offset: $offset, limit: $limit) {\n" +
    "      date\n" +
    "      count\n" +
    "      id\n" +
    "    }\n" +
    "  }\n" +
    "}";
  const RUN_KEY = "__stakeArchiveExportRunning";
  const LOG_PREFIX = "[bet-archive]";

  if (!HOST_RE.test(location.hostname)) {
    alert("Run this bookmarklet while you are on stake.com or stake.us.");
    return;
  }

  if (window[RUN_KEY]) {
    alert("The Stake archive export is already running in this tab.");
    return;
  }

  window[RUN_KEY] = true;

  let ui;
  let canceled = false;

  try {
    const sessionToken = getSessionToken();

    if (!sessionToken) {
      throw new Error("No session cookie found. Make sure you are logged in.");
    }

    const requestedRange = promptDateRange();

    if (!requestedRange) {
      return;
    }

    ui = createUi(() => {
      canceled = true;
    });

    const ensureActive = () => {
      if (canceled) {
        throw new Error("Canceled.");
      }
    };

    ui.status("Choosing save method...");
    const saver = await createSaver(ui);

    ui.status("Listing bet archives...");
    ui.log(
      "Date range: " +
        (requestedRange.startDate || "earliest") +
        " to " +
        (requestedRange.endDate || "latest") +
        "."
    );

    const scan = await collectArchives(sessionToken, requestedRange, ui, ensureActive);

    if (!scan.archives.length) {
      throw new Error(
        scan.listedCount
          ? "No bet archives matched that date range."
          : "No bet archives were returned."
      );
    }

    const firstDate = scan.archives[0].isoDate;
    const lastDate = scan.archives[scan.archives.length - 1].isoDate;
    const exportFolderName = "bet-archives-" + firstDate + "-to-" + lastDate;

    ui.log(
      "Collected " +
        scan.archives.length +
        " archive day(s)" +
        (scan.listedCount !== scan.archives.length
          ? " out of " + scan.listedCount + " listed"
          : "") +
        " from " +
        firstDate +
        " to " +
        lastDate +
        "."
    );

    if (scan.stopReason === "start-date-reached") {
      ui.log("Reached the requested start date and stopped listing early.");
    } else if (scan.stopReason !== "end") {
      ui.log("Stopped listing because " + scan.stopReason + ".");
    }

    ui.status("Saving archives...");
    const result = await saveArchives({
      archives: scan.archives,
      sessionToken,
      requestedRange,
      listingStopReason: scan.stopReason,
      exportFolderName,
      saver,
      ui,
      ensureActive,
    });

    ui.status("Finished.");
    ui.log(
      "Saved " +
        result.saved +
        " archive file(s) to " +
        saver.label +
        "."
    );

    const summary = [
      "Saved " +
        result.saved +
        " of " +
        scan.archives.length +
        " archive file(s).",
      "Requested range: " +
        (requestedRange.startDate || "earliest") +
        " to " +
        (requestedRange.endDate || "latest") +
        ".",
      "Output: " + saver.describe(exportFolderName) + ".",
    ];

    if (scan.stopReason === "start-date-reached") {
      summary.push("Listing stopped early after reaching the requested start date.");
    } else if (scan.stopReason !== "end") {
      summary.push("Listing stopped because " + scan.stopReason + ".");
    }

    if (result.failures.length) {
      summary.push(
        result.failures.length +
          " archive download(s) failed. Check bet-archive-summary.json in the output."
      );
    }

    alert(summary.join("\n\n"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (ui) {
      ui.status("Stopped.");
      ui.log(message);
    }

    console.error(LOG_PREFIX, error);
    alert("Stake archive export failed: " + message);
  } finally {
    delete window[RUN_KEY];
  }

  function getSessionToken() {
    const prefix = "session=";
    const cookies = document.cookie ? document.cookie.split(/;\s*/) : [];

    for (const cookie of cookies) {
      if (!cookie.startsWith(prefix)) {
        continue;
      }

      const value = cookie.slice(prefix.length);

      try {
        return decodeURIComponent(value);
      } catch (_) {
        return value;
      }
    }

    return null;
  }

  function promptDateRange() {
    const startInput = prompt(
      "Start date in YYYY-MM-DD. Leave blank for earliest.",
      ""
    );

    if (startInput === null) {
      return null;
    }

    const endInput = prompt(
      "End date in YYYY-MM-DD. Leave blank for latest.",
      ""
    );

    if (endInput === null) {
      return null;
    }

    const startDate = normalizeDateInput(startInput, "start");
    const endDate = normalizeDateInput(endInput, "end");

    if (startDate && endDate && startDate > endDate) {
      throw new Error("The start date must be on or before the end date.");
    }

    return { startDate, endDate };
  }

  function normalizeDateInput(value, label) {
    const trimmed = String(value || "").trim();

    if (!trimmed) {
      return "";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error("Invalid " + label + " date. Use YYYY-MM-DD.");
    }

    const parsed = new Date(trimmed + "T00:00:00Z");

    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Invalid " + label + " date. Use YYYY-MM-DD.");
    }

    return trimmed;
  }

  async function createSaver(progressUi) {
    const preselectedDirectory = window[PICKER_HANDLE_KEY] || null;
    const pickerWasTried = Boolean(window[PICKER_TRIED_KEY]);

    delete window[PICKER_HANDLE_KEY];
    delete window[PICKER_TRIED_KEY];

    if (
      preselectedDirectory &&
      typeof preselectedDirectory.getDirectoryHandle === "function"
    ) {
      progressUi.log("Using the folder you picked from the bookmarklet.");

      return {
        label: "the selected folder",
        describe(folderName) {
          return folderName + " inside the selected folder";
        },
        async saveText(folderName, fileName, text) {
          const folder = await preselectedDirectory.getDirectoryHandle(folderName, {
            create: true,
          });
          const handle = await folder.getFileHandle(fileName, { create: true });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
        },
      };
    }

    if (!pickerWasTried && typeof window.showDirectoryPicker === "function") {
      try {
        progressUi.log(
          "Choose a folder for the archive export, or cancel to use normal browser downloads."
        );

        const directory = await window.showDirectoryPicker({
          id: "stake-bet-archives",
          mode: "readwrite",
        });

        progressUi.log("Using the selected folder.");

        return {
          label: "the selected folder",
          describe(folderName) {
            return folderName + " inside the selected folder";
          },
          async saveText(folderName, fileName, text) {
            const folder = await directory.getDirectoryHandle(folderName, {
              create: true,
            });
            const handle = await folder.getFileHandle(fileName, { create: true });
            const writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error && error.name !== "AbortError") {
          progressUi.log(
            "Folder picker failed (" + message + "). Falling back to browser downloads."
          );
        } else {
          progressUi.log("Folder picker skipped. Using browser downloads.");
        }
      }
    } else if (pickerWasTried) {
      progressUi.log("Folder picker was skipped. Using browser downloads.");
    } else {
      progressUi.log("File System Access API not available. Using browser downloads.");
    }

    return {
      label: "browser downloads",
      describe() {
        return "your browser downloads";
      },
      async saveText(_folderName, fileName, text) {
        await downloadText(fileName, text);
      },
    };
  }

  async function collectArchives(sessionToken, requestedRange, progressUi, ensureActive) {
    const archives = [];
    let offset = 0;
    let listedCount = 0;
    let stopReason = "end";

    while (true) {
      ensureActive();
      progressUi.status("Listing archives at offset " + offset + "...");

      let page;

      try {
        page = await fetchArchivePage(sessionToken, offset);
      } catch (error) {
        if (!archives.length) {
          throw error;
        }

        stopReason = error instanceof Error ? error.message : String(error);
        progressUi.log("Stopped listing at offset " + offset + ": " + stopReason);
        break;
      }

      if (!page.length) {
        break;
      }

      for (const row of page) {
        listedCount += 1;
        const archive = normalizeArchive(row);

        if (matchesDateRange(archive.isoDate, requestedRange)) {
          archives.push(archive);
        }
      }

      progressUi.log(
        "Listed " +
          listedCount +
          " archive day(s); " +
          archives.length +
          " match the requested range."
      );

      offset += page.length;

      if (requestedRange.startDate) {
        const oldestPageDate = toIsoDate(page[page.length - 1].date);

        if (oldestPageDate < requestedRange.startDate) {
          stopReason = "start-date-reached";
          break;
        }
      }
    }

    archives.sort((left, right) => left.isoDate.localeCompare(right.isoDate));
    return { archives, listedCount, stopReason };
  }

  async function fetchArchivePage(sessionToken, offset) {
    const page = Math.max(0, Math.floor(offset / PAGE_SIZE) - 1);
    const response = await fetch(GRAPHQL_URL, {
      credentials: "include",
      method: "POST",
      mode: "cors",
      referrer: ARCHIVE_PAGE_URL + "?page=" + page,
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-access-token": sessionToken,
        "x-language": "en",
        "x-operation-name": "BetArchive",
        "x-operation-type": "query",
      },
      body: JSON.stringify({
        operationName: "BetArchive",
        query: QUERY,
        variables: {
          limit: PAGE_SIZE,
          offset,
        },
      }),
    });

    if (!response.ok) {
      throw new Error("Archive list request failed with HTTP " + response.status);
    }

    const payload = await response.json();
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];

    if (errors.length) {
      const messages = errors.map((item) => item?.message || "Unknown GraphQL error");
      throw new Error(messages.join("; "));
    }

    const rows = payload?.data?.user?.betArchiveList;

    if (!Array.isArray(rows)) {
      throw new Error("Archive list response did not include betArchiveList.");
    }

    return rows;
  }

  function normalizeArchive(row) {
    const isoDate = toIsoDate(row.date);

    return {
      id: row.id,
      date: row.date,
      isoDate,
      fileName: "bet-archive-" + isoDate + "-" + row.id + ".json",
    };
  }

  function matchesDateRange(isoDate, requestedRange) {
    if (requestedRange.startDate && isoDate < requestedRange.startDate) {
      return false;
    }

    if (requestedRange.endDate && isoDate > requestedRange.endDate) {
      return false;
    }

    return true;
  }

  async function saveArchives({
    archives,
    sessionToken,
    requestedRange,
    listingStopReason,
    exportFolderName,
    saver,
    ui: progressUi,
    ensureActive,
  }) {
    const failures = [];
    let saved = 0;

    for (let index = 0; index < archives.length; index += 1) {
      ensureActive();

      const archive = archives[index];
      progressUi.status(
        "Saving " + (index + 1) + "/" + archives.length + ": " + archive.fileName
      );

      try {
        const text = await fetchArchiveText(sessionToken, archive.id);
        await saver.saveText(exportFolderName, archive.fileName, text);
        saved += 1;
        progressUi.log("Saved " + archive.fileName + ".");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        failures.push({
          id: archive.id,
          date: archive.isoDate,
          message,
        });

        progressUi.log("Failed " + archive.fileName + ": " + message);
      }
    }

    const summaryText = JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        archivesListed: archives.length,
        archivesSaved: saved,
        listingStopReason,
        requestedRange: {
          startDate: requestedRange.startDate || null,
          endDate: requestedRange.endDate || null,
        },
        failures,
      },
      null,
      2
    );

    await saver.saveText(exportFolderName, "bet-archive-summary.json", summaryText);

    return { saved, failures };
  }

  async function fetchArchiveText(sessionToken, id) {
    const response = await fetch(ARCHIVE_URL_PREFIX + id, {
      credentials: "include",
      method: "GET",
      mode: "cors",
      referrer: ARCHIVE_PAGE_URL,
      headers: {
        accept: "application/json, text/plain, */*",
        "x-access-token": sessionToken,
        "x-language": "en",
      },
    });

    if (!response.ok) {
      throw new Error("Archive download failed with HTTP " + response.status);
    }

    return response.text();
  }

  function toIsoDate(value) {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Unexpected archive date: " + String(value));
    }

    return parsed.toISOString().slice(0, 10);
  }

  function createUi(onCancel) {
    const panel = document.createElement("div");
    const status = document.createElement("div");
    const log = document.createElement("pre");
    const actions = document.createElement("div");
    const hideButton = document.createElement("button");
    const cancelButton = document.createElement("button");
    const lines = [];

    panel.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
      "width:420px",
      "max-width:calc(100vw - 32px)",
      "padding:14px",
      "border-radius:12px",
      "border:1px solid rgba(148,163,184,0.35)",
      "background:rgba(15,23,42,0.96)",
      "color:#e2e8f0",
      "box-shadow:0 16px 50px rgba(0,0,0,0.35)",
      "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    ].join(";");

    status.style.cssText = "margin:0 0 10px;font-weight:700;white-space:pre-wrap";
    status.textContent = "Starting...";

    log.style.cssText = [
      "margin:0",
      "padding:12px",
      "max-height:240px",
      "overflow:auto",
      "white-space:pre-wrap",
      "background:rgba(2,6,23,0.65)",
      "border:1px solid rgba(148,163,184,0.2)",
      "border-radius:8px",
    ].join(";");

    actions.style.cssText = "display:flex;gap:8px;margin-top:10px";

    hideButton.textContent = "Hide";
    hideButton.onclick = () => {
      panel.remove();
    };

    cancelButton.textContent = "Cancel";
    cancelButton.onclick = () => {
      cancelButton.disabled = true;
      cancelButton.textContent = "Canceling...";
      onCancel();
    };

    actions.append(hideButton, cancelButton);
    panel.append(status, log, actions);
    document.body.append(panel);

    return {
      status(message) {
        status.textContent = message;
        console.log(LOG_PREFIX, message);
      },
      log(message) {
        lines.push("[" + new Date().toLocaleTimeString() + "] " + message);

        while (lines.length > 14) {
          lines.shift();
        }

        log.textContent = lines.join("\n");
        log.scrollTop = log.scrollHeight;
        console.log(LOG_PREFIX, message);
      },
    };
  }

  async function downloadText(fileName, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    await delay(200);
    link.remove();
    URL.revokeObjectURL(url);
  }

  function delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
})();

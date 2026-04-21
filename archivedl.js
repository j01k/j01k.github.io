(async () => {
  "use strict";

  const HOST_RE = /^stake\.(com|us)$/i;
  const SITE_ORIGIN = HOST_RE.test(location.hostname)
    ? location.origin
    : "https://stake.com";
  const GRAPHQL_URL = SITE_ORIGIN + "/_api/graphql";
  const ARCHIVE_URL_PREFIX = SITE_ORIGIN + "/_api/archive/";
  const ARCHIVE_PAGE_URL = SITE_ORIGIN + "/my-bets/archive";
  const QUERY =
    "query BetArchive($offset: Int = 0, $limit: Int = 100) {\n" +
    "  user {\n" +
    "    id\n" +
    "    betArchiveList(offset: $offset, limit: $limit) {\n" +
    "      date\n" +
    "      count\n" +
    "      id\n" +
    "    }\n" +
    "  }\n" +
    "}";
  const PAGE_SIZE = 100;
  const REFERRER_PAGE_SIZE = 10;
  const ZIP_PART_BYTES = 950 * 1024 * 1024;
  const EMPTY_ZIP_BYTES = 22;
  const RUN_KEY = "__stakeArchiveExportRunning";
  const LOG_PREFIX = "[bet-archive]";
  const encoder = new TextEncoder();
  const crcTable = buildCrcTable();

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

    ui.status("Downloading archives...");
    const result = await exportArchives({
      archives: scan.archives,
      sessionToken,
      saver,
      ui,
      ensureActive,
      listingStopReason: scan.stopReason,
      requestedRange,
    });

    ui.status("Finished.");
    ui.log(
      "Saved " +
        result.partCount +
        " ZIP part(s) with " +
        result.downloaded +
        " archive file(s)."
    );

    const summary = [
      "Downloaded " +
        result.downloaded +
        " of " +
        scan.archives.length +
        " listed archive file(s).",
      "Requested range: " +
        (requestedRange.startDate || "earliest") +
        " to " +
        (requestedRange.endDate || "latest") +
        ".",
      "Saved " + result.partCount + " ZIP part(s) to " + saver.label + ".",
    ];

    if (scan.stopReason === "start-date-reached") {
      summary.push("Listing stopped early after reaching the requested start date.");
    } else if (scan.stopReason !== "end") {
      summary.push("Listing stopped because " + scan.stopReason + ".");
    }

    if (result.failures.length) {
      summary.push(
        result.failures.length +
          " archive download(s) failed. Check bet-archive-summary.json inside the ZIP output."
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

  async function createSaver(progressUi) {
    if (typeof window.showDirectoryPicker === "function") {
      try {
        progressUi.log(
          "Choose a folder for ZIP parts, or cancel to use normal browser downloads."
        );

        const directory = await window.showDirectoryPicker({
          id: "stake-bet-archives",
          mode: "readwrite",
        });

        progressUi.log("Using the selected folder for ZIP parts.");

        return {
          label: "the selected folder",
          async save(blob, fileName) {
            const handle = await directory.getFileHandle(fileName, { create: true });
            const writable = await handle.createWritable();
            await writable.write(blob);
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
    } else {
      progressUi.log("File System Access API not available. Using browser downloads.");
    }

    return {
      label: "browser downloads",
      async save(blob, fileName) {
        await downloadBlob(blob, fileName);
      },
    };
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
        progressUi.log(
          "Stopped listing at offset " + offset + ": " + stopReason
        );
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
    const page = Math.max(0, Math.floor(offset / REFERRER_PAGE_SIZE) - 1);
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

  async function exportArchives({
    archives,
    sessionToken,
    saver,
    ui: progressUi,
    ensureActive,
    listingStopReason,
    requestedRange,
  }) {
    const failures = [];
    const zipLabel =
      "bet-archives-" +
      archives[0].isoDate +
      "-to-" +
      archives[archives.length - 1].isoDate;
    let partNumber = 1;
    let partCount = 0;
    let downloaded = 0;
    let entries = [];
    let estimatedZipSize = EMPTY_ZIP_BYTES;

    const flushPart = async () => {
      if (!entries.length) {
        return;
      }

      ensureActive();

      const fileName =
        zipLabel + "-part-" + String(partNumber).padStart(3, "0") + ".zip";
      progressUi.status("Building " + fileName + "...");

      const blob = new Blob([buildZip(entries)], { type: "application/zip" });
      progressUi.log("Saving " + fileName + " (" + formatBytes(blob.size) + ").");
      await saver.save(blob, fileName);

      partNumber += 1;
      partCount += 1;
      entries = [];
      estimatedZipSize = EMPTY_ZIP_BYTES;
    };

    for (let index = 0; index < archives.length; index += 1) {
      ensureActive();

      const archive = archives[index];
      progressUi.status(
        "Downloading " + (index + 1) + "/" + archives.length + ": " + archive.fileName
      );

      try {
        const text = await fetchArchiveText(sessionToken, archive.id);
        const bytes = encoder.encode(text);
        const nextSize = estimateZipEntrySize(archive.fileName, bytes);

        if (entries.length && estimatedZipSize + nextSize > ZIP_PART_BYTES) {
          await flushPart();
        }

        entries.push({
          name: archive.fileName,
          bytes,
          modifiedAt: new Date(archive.date),
        });
        estimatedZipSize += nextSize;
        downloaded += 1;

        progressUi.log(
          "Queued " +
            archive.fileName +
            " (" +
            formatBytes(bytes.length) +
            ")."
        );
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

    const summaryEntry = buildSummaryEntry({
      archivesListed: archives.length,
      archivesDownloaded: downloaded,
      listingStopReason,
      requestedRange,
      failures,
    });
    const summarySize = estimateZipEntrySize(summaryEntry.name, summaryEntry.bytes);

    if (entries.length && estimatedZipSize + summarySize > ZIP_PART_BYTES) {
      await flushPart();
    }

    entries.push(summaryEntry);
    estimatedZipSize += summarySize;
    await flushPart();

    return { downloaded, partCount, failures };
  }

  function buildSummaryEntry({
    archivesListed,
    archivesDownloaded,
    listingStopReason,
    requestedRange,
    failures,
  }) {
    const body = JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        archivesListed,
        archivesDownloaded,
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

    return {
      name: "bet-archive-summary.json",
      bytes: encoder.encode(body),
      modifiedAt: new Date(),
    };
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

  async function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    await delay(250);
    link.remove();
    URL.revokeObjectURL(url);
  }

  function estimateZipEntrySize(fileName, bytes) {
    const byteLength =
      bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray
        ? bytes.length
        : Number(bytes) || 0;
    const nameLength = encoder.encode(fileName).length;

    return 30 + nameLength + byteLength + 46 + nameLength;
  }

  // Store-only ZIP builder so we do not need a library.
  function buildZip(entries) {
    const fileParts = [];
    const centralParts = [];
    let fileOffset = 0;
    let centralSize = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const bytes =
        entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
      const crc = crc32(bytes);
      const dos = toDosDateTime(entry.modifiedAt || new Date());
      const local = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(local.buffer);

      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dos.time, true);
      localView.setUint16(12, dos.date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, bytes.length, true);
      localView.setUint32(22, bytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      const central = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(central.buffer);

      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, dos.time, true);
      centralView.setUint16(14, dos.date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, bytes.length, true);
      centralView.setUint32(24, bytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, fileOffset, true);
      central.set(nameBytes, 46);

      fileParts.push(local, bytes);
      centralParts.push(central);
      fileOffset += local.length + bytes.length;
      centralSize += central.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);

    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, fileOffset, true);
    endView.setUint16(20, 0, true);

    const output = new Uint8Array(fileOffset + centralSize + end.length);
    let cursor = 0;

    for (const part of fileParts) {
      output.set(part, cursor);
      cursor += part.length;
    }

    for (const part of centralParts) {
      output.set(part, cursor);
      cursor += part.length;
    }

    output.set(end, cursor);
    return output;
  }

  function toDosDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    const year = Math.max(1980, date.getFullYear());

    return {
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time:
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2),
    };
  }

  function buildCrcTable() {
    const table = new Uint32Array(256);

    for (let index = 0; index < 256; index += 1) {
      let value = index;

      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }

      table[index] = value >>> 0;
    }

    return table;
  }

  function crc32(bytes) {
    let value = 0xffffffff;

    for (let index = 0; index < bytes.length; index += 1) {
      value = crcTable[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    }

    return (value ^ 0xffffffff) >>> 0;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return bytes + " B";
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = -1;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + " " + units[unitIndex];
  }
})();

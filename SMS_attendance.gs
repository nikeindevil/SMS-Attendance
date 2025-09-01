/**
 * Attendance Logger with Staff Sheet & Robust Error Handling
 *
 * Only SMS from registered staff numbers (listed in Staff sheet) are processed.
 * Non-staff SMS are IGNORED COMPLETELY (not logged anywhere).
 * Net Hours and Break Minutes shown as HH:MM.
 * Errors (multiple breaks, OUT with open break, OUT before last break out, etc.) logged to Logs sheet.
 * Supervisor can manually correct missed OUT by editing Monthly sheet.
 */

function doGet(e) { return handleRequest(e, "GET"); }
function doPost(e) { return handleRequest(e, "POST"); }

function handleRequest(e, method) {
  try {
    const params = parseParams(e, method);
    const staffPhone = getStaffPhone(params);
    const staffName = getStaffNameFromPhone(staffPhone);

    // If staff not registered, IGNORE the SMS completely (no logging, no error)
    if (!staffName) {
      return ContentService.createTextOutput("IGNORED: Unregistered staff number.").setMimeType(ContentService.MimeType.TEXT);
    }

    const action = normalizeAction(params.action || params.body || "");
    const ts = new Date();

    // Log raw data
    logRaw(params, staffPhone, staffName, action, ts);

    // BreakLog sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const breakSheet = ss.getSheetByName("BreakLog") || ss.insertSheet("BreakLog");
    ensureHeaders(breakSheet, ["Date", "Staff", "BreakStart", "BreakEnd", "BreakMinutes", "Status", "StartMs"]);

    // Monthly sheet
    updateMonthlyAndBreaks(staffName, staffPhone, action, ts, breakSheet);

    return ContentService.createTextOutput("OK - Logged " + staffName + " " + action + " at " + ts.toISOString())
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    logError({}, "", "Script error: " + err.message);
    return ContentService.createTextOutput("ERROR: " + err.message).setMimeType(ContentService.MimeType.TEXT);
  }
}

/* ----------------- STAFF MANAGEMENT ----------------- */

// Returns phone in canonical +91XXXXXXXXXX format
function getStaffPhone(params) {
  let staffRaw = (params.staff || params.from || params.sender || "").toString().trim();
  if (staffRaw.indexOf("|") !== -1) {
    const parts = staffRaw.split("|").map(p => p.trim());
    staffRaw = parts.find(p => p && p.match(/^\+?\d{10,13}$/)) || parts.find(p => p) || "";
  }
  // Normalize to +91XXXXXXXXXX
  let digits = staffRaw.replace(/[^0-9]/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length === 12 && !digits.startsWith("91")) digits = "91" + digits.slice(-10);
  if (digits.length === 12) digits = "+" + digits;
  if (digits.length === 13 && !digits.startsWith("+")) digits = "+" + digits;
  return digits.length >= 12 ? digits : staffRaw;
}

// Returns staff name if phone is registered, else empty string
function getStaffNameFromPhone(phone) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const staffSheet = ss.getSheetByName("Staff");
  if (!staffSheet) return "";
  const data = staffSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const sheetPhone = String(data[i][1] || "").replace(/[^0-9+]/g, "");
    if (sheetPhone && (sheetPhone === phone || ("+" + sheetPhone) === phone)) {
      return String(data[i][0] || "");
    }
  }
  return "";
}

/* ----------------- MONTHLY & BREAK LOG MANAGEMENT ----------------- */

function updateMonthlyAndBreaks(staff, staffPhone, action, ts, breakSheet) {
  const tz = Session.getScriptTimeZone() || "UTC";
  const month = Utilities.formatDate(ts, tz, "yyyy-MM");
  const dateStr = Utilities.formatDate(ts, tz, "yyyy-MM-dd");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = "Monthly-" + month;
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  ensureHeaders(sheet, ["Date", "Staff", "Present/Absent", "IN", "OUT", "Break Minutes", "Net Hours"]);

  // Find monthly row
  const data = sheet.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < data.length; i++) {
    const cellDateStr = getCellDateString(data[i][0], tz);
    if (cellDateStr === dateStr && String(data[i][1] || "") === staff) {
      row = i + 1;
      break;
    }
  }
  if (row === -1) {
    sheet.appendRow([dateStr, staff, "Present", "", "", "00:00", "00:00"]);
    row = sheet.getLastRow();
  }
  const inCell = sheet.getRange(row, 4);
  const outCell = sheet.getRange(row, 5);
  const breakCell = sheet.getRange(row, 6);
  const netCell = sheet.getRange(row, 7);
  const presentCell = sheet.getRange(row, 3);

  const currentIn = inCell.getValue();
  const currentOut = outCell.getValue();

  // --- BREAK LOGIC ---
  const bData = breakSheet.getDataRange().getValues();
  const openBreakIdx = findLatestOpenBreak(bData, dateStr, staff, tz);
  const lastClosedBreakOutMs = getLastClosedBreakOut(bData, dateStr, staff, tz);

  if (action === "IN") {
    if (!currentIn) {
      inCell.setValue(ts);
      inCell.setNumberFormat("HH:mm");
    } else {
      const existingInMs = parseDateLike(currentIn, tz);
      if (ts.getTime() < existingInMs) {
        inCell.setValue(ts);
        inCell.setNumberFormat("HH:mm");
      }
    }
  } else if (action === "OUT") {
    // Error if open break exists
    if (openBreakIdx !== -1) {
      logError({}, staffPhone, "OUT ignored: open BREAK IN exists for staff/date. Break must be closed first.");
      return;
    }
    // Error if OUT earlier than last break out
    if (lastClosedBreakOutMs && ts.getTime() < lastClosedBreakOutMs) {
      logError({}, staffPhone, "OUT ignored: OUT before last BREAK OUT for staff/date.");
      return;
    }
    // Set OUT
    if (!currentOut) {
      outCell.setValue(ts);
      outCell.setNumberFormat("HH:mm");
    } else {
      const existingOutMs = parseDateLike(currentOut, tz);
      if (ts.getTime() > existingOutMs) {
        outCell.setValue(ts);
        outCell.setNumberFormat("HH:mm");
      }
    }
  } else if (action === "BREAK IN") {
    // Error if open break exists
    if (openBreakIdx !== -1) {
      logError({}, staffPhone, "BREAK IN ignored: existing open break for staff/date.");
      return;
    }
    breakSheet.appendRow([dateStr, staff, ts, "", "", "OPEN", ts.getTime()]);
    const last = breakSheet.getLastRow();
    try { breakSheet.getRange(last, 3).setNumberFormat("HH:mm"); } catch (e) { /* ignore */ }
  } else if (action === "BREAK OUT") {
    if (openBreakIdx === -1) {
      logError({}, staffPhone, "BREAK OUT ignored: no open break found for staff/date.");
      return;
    }
    // Only allow BREAK OUT after BREAK IN time
    const startMs = parseDateLike(bData[openBreakIdx - 1][2], tz);
    if (ts.getTime() < startMs) {
      logError({}, staffPhone, "BREAK OUT ignored: BREAK OUT before BREAK IN.");
      return;
    }
    // Close the break
    const mins = Math.round((ts.getTime() - startMs) / 60000);
    breakSheet.getRange(openBreakIdx, 4).setValue(ts); // BreakEnd
    breakSheet.getRange(openBreakIdx, 5).setValue(mins); // BreakMinutes
    breakSheet.getRange(openBreakIdx, 6).setValue("CLOSED"); // Status
    breakSheet.getRange(openBreakIdx, 7).setValue(startMs); // StartMs
    try { breakSheet.getRange(openBreakIdx, 4).setNumberFormat("HH:mm"); } catch (e) { /* ignore */ }
  }

  // --- FORMAT BREAK MINUTES AND NET HOURS as HH:MM ---
  let totalBreak = 0;
  try {
    const bData2 = breakSheet.getDataRange().getValues();
    for (let i = 1; i < bData2.length; i++) {
      const rDate = getCellDateString(bData2[i][0], tz);
      const rStaff = String(bData2[i][1] || "");
      const rMinutes = Number(bData2[i][4]) || 0;
      const rStatus = String(bData2[i][5] || "").toUpperCase();
      if (rDate === dateStr && rStaff === staff && rStatus === "CLOSED") {
        totalBreak += rMinutes;
      }
    }
  } catch (e) {}
  breakCell.setValue(minsToHHMM(totalBreak));

  // --- NET HOURS (HH:MM) ---
  const inVal = inCell.getValue();
  const outVal = outCell.getValue();
  let netMinutes = 0;
  if (inVal && outVal) {
    const inMs = parseDateLike(inVal, tz);
    const outMs = parseDateLike(outVal, tz);
    const grossMs = outMs - inMs;
    netMinutes = Math.floor(grossMs / 60000) - totalBreak;
    netCell.setValue(minsToHHMM(Math.max(0, netMinutes)));
  } else {
    netCell.setValue("00:00");
  }
  presentCell.setValue("Present");
}

/* ----------------- BREAK LOGIC HELPERS ----------------- */

function findLatestOpenBreak(bData, dateStr, staff, tz) {
  let bestIdx = -1;
  let bestStartMs = 0;
  for (let i = 1; i < bData.length; i++) {
    const cellDate = getCellDateString(bData[i][0], tz);
    const rStaff = String(bData[i][1] || "");
    const rStatus = String(bData[i][5] || "").toUpperCase();
    let rStartMs = Number(bData[i][6]) || 0;
    if (!rStartMs && bData[i][2] instanceof Date) rStartMs = bData[i][2].getTime();
    if (cellDate === dateStr && rStaff === staff && rStatus === "OPEN" && rStartMs > bestStartMs) {
      bestStartMs = rStartMs;
      bestIdx = i + 1; // 1-based sheet row index
    }
  }
  return bestIdx;
}

function getLastClosedBreakOut(bData, dateStr, staff, tz) {
  let lastOut = 0;
  for (let i = 1; i < bData.length; i++) {
    const cellDate = getCellDateString(bData[i][0], tz);
    const rStaff = String(bData[i][1] || "");
    const rStatus = String(bData[i][5] || "").toUpperCase();
    if (cellDate === dateStr && rStaff === staff && rStatus === "CLOSED") {
      const breakOutVal = bData[i][4];
      const breakOutMs = parseDateLike(breakOutVal, tz);
      if (breakOutMs > lastOut) lastOut = breakOutMs;
    }
  }
  return lastOut;
}

/* ----------------- LOGGING & FORMATTING ----------------- */

function minsToHHMM(mins) {
  mins = Math.max(0, Math.floor(mins));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return ("0" + h).slice(-2) + ":" + ("0" + m).slice(-2);
}

function logError(params, staffPhone, msg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("Logs") || ss.insertSheet("Logs");
  ensureHeaders(logSheet, ["Timestamp", "Phone", "Staff", "Action", "Error"]);
  const ts = new Date();
  const staffName = getStaffNameFromPhone(staffPhone) || "";
  logSheet.appendRow([ts, staffPhone, staffName, params.action || "", msg]);
}

function logRaw(params, staffPhone, staffName, action, ts) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("RawLogs") || ss.insertSheet("RawLogs");
  ensureHeaders(rawSheet, ["ReceivedAt", "Timestamp", "StaffRaw", "StaffResolved", "ActionRaw", "ActionNormalized", "Payload"]);
  ensureRawLogsProtection(rawSheet);
  rawSheet.appendRow([new Date(), ts, staffPhone, staffName, params.action || params.body || "", action, JSON.stringify(params)]);
}

/* ----------------- HEADER & UTILITY ----------------- */

function ensureHeaders(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    sheet.appendRow(headers);
    return;
  }
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0] || [];
  let mismatch = false;
  for (let i = 0; i < headers.length; i++) {
    if (firstRow[i] !== headers[i]) { mismatch = true; break; }
  }
  if (mismatch) {
    sheet.deleteRow(1);
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function ensureRawLogsProtection(sheet) {
  try {
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    if (protections && protections.length > 0) return;
    const protection = sheet.protect();
    protection.setDescription("Protected RawLogs - managed by script");
    try {
      const me = Session.getEffectiveUser();
      protection.removeEditors(protection.getEditors());
      protection.addEditor(me);
    } catch (e) {
      Logger.log("Could not set RawLogs protection editors: " + e.message);
    }
    protection.setWarningOnly(false);
  } catch (err) {
    Logger.log("Warning: ensureRawLogsProtection failed: " + err.message);
  }
}

function parseParams(e, method) {
  const params = {};
  if (e.parameter) {
    Object.keys(e.parameter).forEach(k => {
      params[k] = Array.isArray(e.parameter[k]) ? e.parameter[k][0] : e.parameter[k];
    });
  }
  if (method === "POST" && e.postData && e.postData.contents) {
    const content = e.postData.contents;
    const type = (e.postData.type || "").toString().toLowerCase();
    if (type.indexOf("application/json") !== -1 || (content && content.trim().startsWith("{"))) {
      try {
        const j = JSON.parse(content);
        for (const k in j) if (Object.prototype.hasOwnProperty.call(j, k)) params[k] = j[k];
      } catch (err) { params._raw = content; }
    } else {
      content.split("&").forEach(part => {
        if (!part) return;
        const idx = part.indexOf("=");
        let key, val;
        if (idx >= 0) { key = part.substring(0, idx); val = part.substring(idx + 1); }
        else { key = part; val = ""; }
        try { key = decodeURIComponent(key.replace(/\+/g, " ")); } catch (e) { key = key.replace(/\+/g, " "); }
        try { val = decodeURIComponent((val || "").replace(/\+/g, " ")); } catch (e) { val = (val || "").replace(/\+/g, " "); }
        if (key) params[key] = val;
      });
    }
  }
  // fallback: detect bare phone sent as key
  if (!params.staff) {
    for (const k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      if (k.toLowerCase() === "action" || k.toLowerCase() === "body") continue;
      const v = params[k];
      const digitsOnly = k.replace(/\D/g, "");
      if ((v === "" || v === undefined) && digitsOnly.length >= 6 && digitsOnly.length <= 15) {
        params.staff = k;
        delete params[k];
        break;
      }
    }
  }
  return params;
}

function getCellDateString(cellVal, tz) {
  tz = tz || Session.getScriptTimeZone() || "UTC";
  if (!cellVal && cellVal !== 0) return "";
  if (Object.prototype.toString.call(cellVal) === "[object Date]") {
    return Utilities.formatDate(cellVal, tz, "yyyy-MM-dd");
  }
  if (typeof cellVal === "number") {
    const d = new Date(cellVal);
    return Utilities.formatDate(d, tz, "yyyy-MM-dd");
  }
  const s = String(cellVal).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) return Utilities.formatDate(new Date(parsed), tz, "yyyy-MM-dd");
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Utilities.formatDate(d, tz, "yyyy-MM-dd");
  }
  return "";
}

function parseDateLike(val, tz) {
  tz = tz || Session.getScriptTimeZone() || "UTC";
  if (!val && val !== 0) return 0;
  if (Object.prototype.toString.call(val) === "[object Date]") return val.getTime();
  if (typeof val === "number") return val;
  const s = String(val).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const parts = s.split(":");
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(parts[0]), Number(parts[1]), 0).getTime();
  }
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) return parsed;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const y = Number(m[3]), mo = Number(m[2]) - 1, da = Number(m[1]);
    const hh = m[4] ? Number(m[4]) : 0, mm = m[5] ? Number(m[5]) : 0, ss = m[6] ? Number(m[6]) : 0;
    return new Date(y, mo, da, hh, mm, ss).getTime();
  }
  return 0;
}

/* ----------------- ACTION NORMALIZATION ----------------- */
function normalizeAction(raw) {
  if (!raw) return "UNKNOWN";
  let a = raw.toString().trim().toLowerCase();
  a = a.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (/\bbreak\b/.test(a) && /\bin\b/.test(a)) return "BREAK IN";
  if (/\bbreak\b/.test(a) && /\bout\b/.test(a)) return "BREAK OUT";
  if (/\bbreakin\b/.test(a) || /\bbreak-in\b/.test(raw)) return "BREAK IN";
  if (/\bbreakout\b/.test(a) || /\bbreak-out\b/.test(raw)) return "BREAK OUT";
  if (/\bin\b/.test(a) && !/\bbreak\b/.test(a)) return "IN";
  if (/\bout\b/.test(a) && !/\bbreak\b/.test(a)) return "OUT";
  if (a === "i" || a === "start") return "IN";
  if (a === "o" || a === "stop") return "OUT";
  return raw.toString().toUpperCase();
}
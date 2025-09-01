# SMS-Attendance
Google Sheets App Script
1. Add the Script in the google sheets
2. Copy the Webhook URL and paste it in Macrodroid
3. Setup Macrodroid
Immediate checklist (most common causes)

Web App deployment:
In Apps Script: Deploy → New deployment → Web app
Execute as: Me
Who has access: Anyone, even anonymous (or at least Anyone)
Copy that Web App URL into MacroDroid exactly (no trailing slash changes usually OK)

MacroDroid HTTP action settings:
Method = POST (or test with GET)
URL = your Web App URL
Content-Type = application/x-www-form-urlencoded (or test with text/plain or application/json depending on what MacroDroid sends)
Body = staff=%SMS_SENDER%&action=%SMS_BODY% (this is correct for form-encoded)
Use variables from the Macrodroid instead
    Do NOT type %SMS_CONTACT_NAME% or %SMS_BODY% manually. Instead:
    Type: staff=
    Click the variable/insert button (usually a { } or + icon next to the field) and select the appropriate variable for "SMS Contact Name" (the UI option name may be "SMS Contact Name" or similar).
    Type a pipe character: |
    Click the variable/insert button again and select "SMS Sender" (or "SMS Sender Number").
    Type: &action=
    Click the variable selector and choose "SMS Body".

Enable “Save response body to variable” and “Save response code to variable” so MacroDroid doesn’t “fail silently”
Phone connectivity & MacroDroid permissions:
Phone has working mobile data or Wi‑Fi
MacroDroid allowed to use background data
MacroDroid is allowed to run when screen off (battery optimizations disabled if needed)
Confirm the script can receive anonymous requests:
If you made the app restricted to your account, MacroDroid will not be authorized to POST; set access to Anyone, even anonymous to test.

Instructions:

Add a Staff sheet with header (Staff Name, Phone Number), and list staff phone numbers in canonical +91XXXXXXXXXX format.
Only registered staff numbers will be processed.
Non-staff SMS are completely ignored (no entry in any log/sheet).
Errors for valid staff (e.g. open breaks, multiple breaks, OUT before break out, etc.) are logged to the Logs sheet.
Net Hours and Break Minutes are always shown as HH:MM.
RawLogs are protected.
Let me know if you need a sample Staff sheet.


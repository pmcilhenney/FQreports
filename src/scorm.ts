import { strToU8, zipSync } from "fflate";

export type ScormPackageOptions = {
  quizId: string;
  quizName: string;
  bridgeUrl: string;
  packageToken: string;
};

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(value: string): string {
  return xml(value).replace(/'/g, "&#39;");
}

function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "flexiquiz";
}

function manifest(opts: ScormPackageOptions): string {
  const id = identifier(opts.quizId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="FQ_${xml(id)}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                      http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG_${xml(id)}">
    <organization identifier="ORG_${xml(id)}">
      <title>${xml(opts.quizName)}</title>
      <item identifier="ITEM_${xml(id)}" identifierref="RES_${xml(id)}">
        <title>${xml(opts.quizName)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES_${xml(id)}" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html" />
    </resource>
  </resources>
</manifest>
`;
}

function indexHtml(opts: ScormPackageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(opts.quizName)}</title>
  <style>
    :root { color-scheme: light; --text: #172026; --muted: #61707a; --line: #d7dee2; }
    * { box-sizing: border-box; }
    html, body, main { width: 100%; height: 100%; min-height: 100%; }
    body { margin: 0; color: var(--text); font-family: Arial, Helvetica, sans-serif; background: white; }
    main { display: grid; grid-template-rows: auto 1fr; }
    .status { min-height: 34px; padding: 8px 12px; background: white; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 13px; }
    iframe { width: 100%; height: 100%; min-height: 760px; border: 0; background: white; }
  </style>
</head>
<body>
  <main>
    <div class="status" id="statusText">Preparing ${html(opts.quizName)}...</div>
    <iframe id="quizFrame" title="${html(opts.quizName)}"></iframe>
  </main>
  <script>
    var API = null;
    var bridgeUrl = "${html(opts.bridgeUrl)}";
    var packageToken = "${html(opts.packageToken)}";
    var sessionId = "";
    var pollTimer = 0;
    function findApi(win) {
      var attempts = 0;
      while (win && attempts < 500) {
        if (win.API) return win.API;
        attempts += 1;
        if (win.parent === win) break;
        win = win.parent;
      }
      if (window.opener && window.opener.API) return window.opener.API;
      return null;
    }
    function lms(command, name, value) {
      try {
        if (!API) API = findApi(window);
        if (!API) return "";
        if (command === "initialize") return API.LMSInitialize("");
        if (command === "set") return API.LMSSetValue(name, value);
        if (command === "commit") return API.LMSCommit("");
        if (command === "finish") return API.LMSFinish("");
      } catch (error) {}
      return "";
    }
    function lmsGet(name) {
      try {
        if (!API) API = findApi(window);
        if (!API) return "";
        return API.LMSGetValue(name) || "";
      } catch (error) {}
      return "";
    }
    function setLesson(status, score) {
      lms("set", "cmi.core.lesson_status", status);
      if (typeof score === "number") {
        lms("set", "cmi.core.score.min", "0");
        lms("set", "cmi.core.score.max", "100");
        lms("set", "cmi.core.score.raw", String(score));
      }
      lms("commit");
    }
    function setStatus(text) {
      document.getElementById("statusText").textContent = text;
    }
    function parseName(value) {
      var raw = String(value || "").trim();
      if (!raw) return { firstName: "", lastName: "" };
      if (raw.indexOf(",") >= 0) {
        var parts = raw.split(",");
        return { firstName: parts.slice(1).join(",").trim(), lastName: parts[0].trim() };
      }
      var tokens = raw.split(/\\s+/);
      return { firstName: tokens.slice(0, -1).join(" "), lastName: tokens.slice(-1).join(" ") };
    }
    async function post(path, body) {
      var response = await fetch(bridgeUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Bridge request failed.");
      return payload;
    }
    async function pollResult() {
      if (!sessionId) return;
      try {
        var result = await post("/api/scorm/result", { sessionId: sessionId, packageToken: packageToken });
        if (result.completed) {
          window.clearInterval(pollTimer);
          setLesson(result.pass ? "passed" : "failed", result.score);
          setStatus("Score recorded in Moodle: " + result.score + "%");
        } else {
          setLesson("incomplete");
          setStatus("Quiz in progress. Results will sync to Moodle after submission.");
        }
      } catch (error) {
        setStatus(error.message);
      }
    }
    async function boot() {
      lms("initialize");
      setLesson("incomplete");
      var name = lmsGet("cmi.core.student_name");
      var parsed = parseName(name);
      var studentId = lmsGet("cmi.core.student_id") || "unknown";
      try {
        var session = await post("/api/scorm/session", {
          packageToken: packageToken,
          quizId: "${html(opts.quizId)}",
          moodleStudentId: studentId,
          moodleStudentName: name,
          firstName: parsed.firstName,
          lastName: parsed.lastName
        });
        sessionId = session.sessionId;
        document.getElementById("quizFrame").src = session.launchUrl;
        lms("set", "cmi.core.lesson_location", sessionId);
        setStatus("Quiz loaded. Results will sync to Moodle after submission.");
        pollTimer = window.setInterval(pollResult, 10000);
        window.setTimeout(pollResult, 4000);
      } catch (error) {
        setStatus(error.message);
      }
    }
    boot();
    window.addEventListener("beforeunload", function () { lms("commit"); lms("finish"); });
  </script>
</body>
</html>
`;
}

export function buildScormPackage(opts: ScormPackageOptions): Uint8Array {
  const files = {
    "imsmanifest.xml": strToU8(manifest(opts)),
    "index.html": strToU8(indexHtml(opts)),
  };
  return zipSync(files, { level: 6 });
}

import { strToU8, zipSync } from "fflate";

export type ScormLaunchMode = "new_window" | "iframe";

export type ScormPackageOptions = {
  quizId: string;
  quizName: string;
  launchUrl: string;
  launchMode: ScormLaunchMode;
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
  const useIframe = opts.launchMode === "iframe";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(opts.quizName)}</title>
  <style>
    :root { color-scheme: light; --accent: #0b6b5c; --text: #172026; --muted: #61707a; --line: #d7dee2; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--text); font-family: Arial, Helvetica, sans-serif; background: #f4f6f7; }
    main { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    header, footer { background: white; border-bottom: 1px solid var(--line); padding: 14px 18px; }
    footer { border-top: 1px solid var(--line); border-bottom: 0; color: var(--muted); font-size: 13px; }
    h1 { margin: 0; font-size: 20px; }
    p { margin: 6px 0 0; color: var(--muted); }
    .launch { display: flex; align-items: center; gap: 10px; padding: 14px 18px; background: white; border-bottom: 1px solid var(--line); }
    button, a.button { min-height: 38px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: white; padding: 0 14px; text-decoration: none; display: inline-flex; align-items: center; cursor: pointer; font-size: 14px; }
    iframe { width: 100%; height: 100%; min-height: 680px; border: 0; background: white; }
    .empty { display: grid; place-items: center; padding: 32px; text-align: center; }
    .box { max-width: 720px; background: white; border: 1px solid var(--line); border-radius: 8px; padding: 22px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${html(opts.quizName)}</h1>
      <p>This SCORM package launches the live FlexiQuiz quiz. FlexiQuiz remains the source of truth for responses, scoring, and review records.</p>
    </header>
    <section class="launch">
      <a class="button" id="launchLink" href="${html(opts.launchUrl)}" target="_blank" rel="noopener">Open FlexiQuiz</a>
      <button id="completeBtn" type="button">Mark Launched</button>
      <span id="statusText">Ready</span>
    </section>
    ${useIframe ? `<iframe src="${html(opts.launchUrl)}" title="${html(opts.quizName)}"></iframe>` : `<section class="empty"><div class="box"><h2>Open the hosted quiz</h2><p>Use the button above to open FlexiQuiz in a new tab or window. Return here and mark it launched so Moodle records the SCORM activity interaction.</p></div></section>`}
    <footer>Quiz ID: ${html(opts.quizId)}</footer>
  </main>
  <script>
    var API = null;
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
    function setStatus(status) {
      lms("set", "cmi.core.lesson_status", status);
      lms("set", "cmi.core.score.raw", "");
      lms("commit");
      document.getElementById("statusText").textContent = status === "completed" ? "Launched in Moodle" : "Opened";
    }
    lms("initialize");
    lms("set", "cmi.core.lesson_location", "${html(opts.launchUrl)}");
    setStatus("browsed");
    document.getElementById("launchLink").addEventListener("click", function () { setStatus("completed"); });
    document.getElementById("completeBtn").addEventListener("click", function () { setStatus("completed"); });
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

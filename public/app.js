const state = {
  quizzes: [],
  exports: new Map(),
  selected: new Set(),
  activeTab: "moodle",
};

const $ = (selector) => document.querySelector(selector);
const keyStatus = $("#keyStatus");
const refreshBtn = $("#refreshBtn");
const searchInput = $("#searchInput");
const statusFilter = $("#statusFilter");
const quizRows = $("#quizRows");
const reportQuizRows = $("#reportQuizRows");
const selectedCount = $("#selectedCount");
const selectVisibleBtn = $("#selectVisibleBtn");
const clearSelectedBtn = $("#clearSelectedBtn");
const runReportBtn = $("#runReportBtn");
const dateFrom = $("#dateFrom");
const dateTo = $("#dateTo");
const passFilter = $("#passFilter");
const responseStatusFilter = $("#responseStatusFilter");
const responseSearch = $("#responseSearch");
const includeQuestions = $("#includeQuestions");
const summaryGrid = $("#summaryGrid");
const resultsWrap = $("#resultsWrap");
const resultRows = $("#resultRows");
const toast = $("#toast");

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 5200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
  return payload;
}

function statusLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function defaultCategory(quiz) {
  return `EMS Academy/${quiz.name || "Exam"}`;
}

function quizKey(quiz) {
  return String(quiz.quiz_id || quiz.id || "");
}

function visibleQuizzes() {
  const query = searchInput.value.trim().toLowerCase();
  const status = statusFilter.value;
  return state.quizzes.filter((quiz) => {
    const matchesSearch = !query || String(quiz.name || "").toLowerCase().includes(query);
    const matchesStatus = !status || quiz.status === status;
    return matchesSearch && matchesStatus;
  });
}

function renderMoodleRows() {
  const quizzes = visibleQuizzes();
  if (!quizzes.length) {
    quizRows.innerHTML = '<tr><td colspan="5" class="empty">No matching exams.</td></tr>';
    return;
  }
  quizRows.innerHTML = "";
  for (const quiz of quizzes) {
    const id = quizKey(quiz);
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.innerHTML = `<div class="examName"></div><div class="muted"></div>`;
    name.querySelector(".examName").textContent = quiz.name || "(Untitled)";
    name.querySelector(".muted").textContent = id;

    const status = document.createElement("td");
    status.innerHTML = `<span class="status ${quiz.status || ""}"></span>`;
    status.querySelector(".status").textContent = statusLabel(quiz.status);

    const created = document.createElement("td");
    created.textContent = quiz.date_created || "";

    const category = document.createElement("td");
    const categoryInput = document.createElement("input");
    categoryInput.className = "categoryInput";
    categoryInput.value = defaultCategory(quiz);
    categoryInput.ariaLabel = `Moodle category for ${quiz.name}`;
    category.append(categoryInput);

    const actions = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "actions";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Export XML";
    button.addEventListener("click", () => exportQuiz(quiz, categoryInput.value, button));
    wrap.append(button);

    const existing = state.exports.get(id);
    if (existing) {
      const link = document.createElement("a");
      link.className = "downloadLink";
      link.href = existing.downloadUrl;
      link.textContent = "Download";
      link.download = existing.filename;
      wrap.append(link);
      if (existing.skippedCount) {
        const skipped = document.createElement("span");
        skipped.className = "skipped";
        skipped.textContent = `${existing.skippedCount} skipped`;
        wrap.append(skipped);
      }
    }
    actions.append(wrap);
    tr.append(name, status, created, category, actions);
    quizRows.append(tr);
  }
}

function renderReportRows() {
  const quizzes = visibleQuizzes();
  selectedCount.textContent = `${state.selected.size} selected`;
  if (!quizzes.length) {
    reportQuizRows.innerHTML = '<tr><td colspan="5" class="empty">No matching exams.</td></tr>';
    return;
  }
  reportQuizRows.innerHTML = "";
  for (const quiz of quizzes) {
    const id = quizKey(quiz);
    const tr = document.createElement("tr");
    const select = document.createElement("td");
    select.className = "selectCol";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
      renderReportRows();
    });
    select.append(checkbox);

    const name = document.createElement("td");
    name.innerHTML = `<div class="examName"></div><div class="muted"></div>`;
    name.querySelector(".examName").textContent = quiz.name || "(Untitled)";
    name.querySelector(".muted").textContent = id;

    const status = document.createElement("td");
    status.innerHTML = `<span class="status ${quiz.status || ""}"></span>`;
    status.querySelector(".status").textContent = statusLabel(quiz.status);

    const created = document.createElement("td");
    created.textContent = quiz.date_created || "";

    const responses = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Preview";
    button.addEventListener("click", () => previewResponses(quiz, button));
    responses.append(button);
    tr.append(select, name, status, created, responses);
    reportQuizRows.append(tr);
  }
}

function renderAll() {
  renderMoodleRows();
  renderReportRows();
}

async function loadConfig() {
  const payload = await api("/api/config");
  keyStatus.textContent = payload.flexiquizConfigured
    ? "FlexiQuiz API key configured in Cloudflare."
    : "FlexiQuiz API key missing. Set FLEXIQUIZ_API_KEY with Wrangler.";
}

async function loadQuizzes() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Loading...";
  try {
    await loadConfig();
    const payload = await api("/api/quizzes");
    state.quizzes = payload.quizzes || [];
    renderAll();
    showToast(`Loaded ${state.quizzes.length} exams.`);
  } catch (error) {
    renderAll();
    showToast(error.message, true);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

async function exportQuiz(quiz, category, button) {
  const id = quizKey(quiz);
  button.disabled = true;
  button.textContent = "Exporting...";
  try {
    const payload = await api("/api/moodle/export", {
      method: "POST",
      body: JSON.stringify({ quizId: id, quizName: quiz.name, category }),
    });
    state.exports.set(id, payload);
    renderMoodleRows();
    const skipped = payload.skippedCount ? ` ${payload.skippedCount} skipped.` : "";
    showToast(`Exported ${payload.convertedCount} questions.${skipped}`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Export XML";
  }
}

async function previewResponses(quiz, button) {
  button.disabled = true;
  button.textContent = "Loading...";
  try {
    const payload = await api(`/api/quizzes/${encodeURIComponent(quizKey(quiz))}/responses`);
    showToast(`${payload.responses.length} responses found for ${quiz.name || "this exam"}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Preview";
  }
}

function renderSummary(summary, csvUrl) {
  summaryGrid.hidden = false;
  const avg = summary.averageScore === null ? "n/a" : `${summary.averageScore}%`;
  summaryGrid.innerHTML = `
    <div><span>Total</span><strong>${summary.totalResponses}</strong></div>
    <div><span>Passed</span><strong>${summary.passCount}</strong></div>
    <div><span>Failed</span><strong>${summary.failCount}</strong></div>
    <div><span>Average</span><strong>${avg}</strong></div>
    <a class="downloadButton" href="${csvUrl}" download>Download CSV</a>
  `;
}

function renderResults(rows) {
  resultsWrap.hidden = !rows.length;
  resultRows.innerHTML = "";
  for (const row of rows.slice(0, 250)) {
    const tr = document.createElement("tr");
    for (const value of [
      row.dateSubmitted,
      row.quizName,
      row.learnerName,
      row.email,
      row.score === null ? "" : `${row.score}%`,
      row.pass === null ? "" : row.pass ? "Pass" : "Fail",
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    resultRows.append(tr);
  }
}

async function runReport() {
  runReportBtn.disabled = true;
  runReportBtn.textContent = "Running...";
  try {
    const payload = await api("/api/reports/run", {
      method: "POST",
      body: JSON.stringify({
        quizIds: [...state.selected],
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
        passFilter: passFilter.value,
        statusFilter: responseStatusFilter.value,
        search: responseSearch.value,
        includeQuestions: includeQuestions.checked,
      }),
    });
    renderSummary(payload.summary, payload.csvUrl);
    renderResults(payload.rows || []);
    showToast(`Report ready with ${payload.summary.totalResponses} responses.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    runReportBtn.disabled = false;
    runReportBtn.textContent = "Run Report";
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    state.activeTab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    $("#moodlePanel").classList.toggle("active", state.activeTab === "moodle");
    $("#reportsPanel").classList.toggle("active", state.activeTab === "reports");
  });
}

refreshBtn.addEventListener("click", loadQuizzes);
searchInput.addEventListener("input", renderAll);
statusFilter.addEventListener("change", renderAll);
selectVisibleBtn.addEventListener("click", () => {
  for (const quiz of visibleQuizzes()) state.selected.add(quizKey(quiz));
  renderReportRows();
});
clearSelectedBtn.addEventListener("click", () => {
  state.selected.clear();
  renderReportRows();
});
runReportBtn.addEventListener("click", runReport);

loadQuizzes();

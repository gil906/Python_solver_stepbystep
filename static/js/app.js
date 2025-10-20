const codeInput = document.getElementById("code");
const runBtn = document.getElementById("run-btn");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const statusEl = document.getElementById("status");
const stdoutEl = document.getElementById("stdout");
const errorEl = document.getElementById("error");
const codeLinesEl = document.getElementById("code-lines");
const stepDetailsEl = document.getElementById("step-details");
const loadSampleBtn = document.getElementById("load-sample");

let trace = [];
let currentIndex = -1;
let truncated = false;
let timedOut = false;

async function runCode() {
    const code = codeInput.value;
    if (!code.trim()) {
        statusEl.textContent = "Please enter some Python code.";
        return;
    }

    toggleControls(true);
    statusEl.textContent = "Running & capturing execution...";
    stdoutEl.textContent = "";
    errorEl.textContent = "";
    stepDetailsEl.innerHTML = "";
    renderCodeLines(code);

    try {
        const response = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code })
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        const result = await response.json();
        trace = Array.isArray(result.trace) ? result.trace : [];
        truncated = Boolean(result.truncated);
        timedOut = Boolean(result.timedOut);

        stdoutEl.textContent = result.stdout || "";
        errorEl.textContent = result.error || "";

        if (trace.length === 0) {
            currentIndex = -1;
            statusEl.textContent = timedOut
                ? "Execution timed out before producing a trace."
                : "No trace available. Did your code run without hitting any Python lines?";
            updateControls();
            return;
        }

        currentIndex = 0;
        showStep(trace[currentIndex]);
        statusEl.textContent = buildStatusMessage();
    } catch (error) {
        console.error(error);
        statusEl.textContent = "Failed to execute code. Check the console for details.";
        errorEl.textContent = error instanceof Error ? error.message : String(error);
        trace = [];
        currentIndex = -1;
    } finally {
        toggleControls(false);
        updateControls();
    }
}

function toggleControls(isRunning) {
    runBtn.disabled = isRunning;
    prevBtn.disabled = isRunning || currentIndex <= 0;
    nextBtn.disabled = isRunning || trace.length === 0 || currentIndex >= trace.length - 1;
}

function updateControls() {
    prevBtn.disabled = trace.length === 0 || currentIndex <= 0;
    nextBtn.disabled = trace.length === 0 || currentIndex >= trace.length - 1;
}

function buildStatusMessage() {
    let parts = [`Step ${currentIndex + 1} of ${trace.length}`];
    if (truncated) {
        parts.push(`Stopped early at ${trace.length} steps.`);
    }
    if (timedOut) {
        parts.push("Execution timed out.");
    }
    return parts.join(" · ");
}

function renderCodeLines(code) {
    codeLinesEl.innerHTML = "";
    const lines = code.split("\n");
    if (lines.length === 0) {
        return;
    }

    lines.forEach((line, index) => {
        const wrapper = document.createElement("div");
        wrapper.className = "code-line";
        wrapper.dataset.line = String(index + 1);

        const number = document.createElement("span");
        number.className = "line-number";
        number.textContent = String(index + 1);

        const text = document.createElement("pre");
        text.className = "line-code";
        text.textContent = line === "" ? " " : line;

        wrapper.append(number, text);
        codeLinesEl.appendChild(wrapper);
    });
}

function highlightLine(lineNumber) {
    const nodes = codeLinesEl.querySelectorAll(".code-line");
    nodes.forEach(node => node.classList.remove("active"));

    if (!lineNumber) {
        return;
    }

    const target = codeLinesEl.querySelector(`.code-line[data-line='${lineNumber}']`);
    if (target) {
        target.classList.add("active");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
}

function showStep(step) {
    if (!step) {
        return;
    }

    highlightLine(step.line);

    const localsFormatted = formatMapping(step.locals);
    const globalsFormatted = formatMapping(step.globals);
    const stackFormatted = formatStack(step.stack);

    const metaLines = [
        `<div><strong>Event:</strong> ${step.event}</div>`,
        `<div><strong>Line:</strong> ${step.line ?? "-"}</div>`
    ];

    if (step.return_value) {
        metaLines.push(`<div><strong>Return:</strong> ${step.return_value}</div>`);
    }
    if (step.exception) {
        metaLines.push(`<div class="exception"><strong>Exception:</strong> ${step.exception.type}: ${step.exception.value}</div>`);
    }

    stepDetailsEl.innerHTML = `
        <div class="step-meta">
            ${metaLines.join("")}
        </div>
        <h3>Current Frame Locals</h3>
        <pre>${localsFormatted || "(no locals)"}</pre>
        <h3>Globals</h3>
        <pre>${globalsFormatted || "(no globals)"}</pre>
        <h3>Call Stack</h3>
        ${stackFormatted || '<p class="empty">(stack empty)</p>'}
    `;

    statusEl.textContent = buildStatusMessage();
}

function formatMapping(mapping) {
    if (!mapping || typeof mapping !== "object") {
        return "";
    }
    const entries = Object.entries(mapping);
    if (entries.length === 0) {
        return "";
    }
    return entries
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
}

function formatStack(stack) {
    if (!Array.isArray(stack) || stack.length === 0) {
        return "";
    }
    return stack
        .map(frame => {
            const locals = formatMapping(frame.locals) || "(no locals)";
            return `
                <div class="frame">
                    <div class="frame-header">${frame.function} &mdash; line ${frame.line}</div>
                    <pre>${locals}</pre>
                </div>
            `;
        })
        .join("");
}

runBtn.addEventListener("click", runCode);

prevBtn.addEventListener("click", () => {
    if (currentIndex <= 0) {
        return;
    }
    currentIndex -= 1;
    showStep(trace[currentIndex]);
    updateControls();
});

nextBtn.addEventListener("click", () => {
    if (currentIndex >= trace.length - 1) {
        return;
    }
    currentIndex += 1;
    showStep(trace[currentIndex]);
    updateControls();
});

loadSampleBtn.addEventListener("click", () => {
    codeInput.value = `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

value = 4
result = factorial(value)
print(f"{value}! = {result}")`;
    renderCodeLines(codeInput.value);
});

// Initialise display with current textarea content
renderCodeLines(codeInput.value);

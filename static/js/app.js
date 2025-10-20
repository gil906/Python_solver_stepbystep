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
const visualCanvasEl = document.getElementById("visual-canvas");
const progressBar = document.getElementById("progress-bar");

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

    trace = [];
    currentIndex = -1;
    truncated = false;
    timedOut = false;
    toggleControls(true);
    statusEl.textContent = "Running & capturing execution...";
    stdoutEl.textContent = "";
    errorEl.textContent = "";
    stepDetailsEl.innerHTML = "";
    renderCodeLines(code);
    renderVisuals(null, "Collecting trace...");
    updateProgressBar();

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
            renderVisuals(null, timedOut ? "Timed out." : "No visual data captured.");
            updateProgressBar();
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
        renderVisuals(null, "Unable to visualise state.");
    } finally {
        toggleControls(false);
        updateProgressBar();
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
    renderVisuals(step);
    updateProgressBar();
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
        .map(([key, value]) => {
            if (value && typeof value === "object" && "repr" in value) {
                return `${key}: ${value.repr}`;
            }
            return `${key}: ${String(value)}`;
        })
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

function updateProgressBar() {
    if (!progressBar) {
        return;
    }
    if (trace.length === 0 || currentIndex < 0) {
        progressBar.style.width = "0%";
        return;
    }
    const ratio = Math.max(0, Math.min(1, (currentIndex + 1) / trace.length));
    progressBar.style.width = `${(ratio * 100).toFixed(0)}%`;
}

function renderVisuals(step, placeholderMessage) {
    if (!visualCanvasEl) {
        return;
    }
    visualCanvasEl.innerHTML = "";

    if (!step) {
        const message = document.createElement("p");
        message.className = "empty";
        message.textContent = placeholderMessage || "Run the visualizer to see variables change.";
        visualCanvasEl.appendChild(message);
        appendTraceNotes();
        return;
    }

    const locals = step.locals && typeof step.locals === "object" ? step.locals : {};
    const names = Object.keys(locals).sort();

    if (names.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No local variables are available at this step.";
        visualCanvasEl.appendChild(empty);
        appendTraceNotes();
        return;
    }

    const fragment = document.createDocumentFragment();

    names.forEach(name => {
        const descriptor = locals[name];
        const card = document.createElement("div");
        card.className = "viz-card";

        const header = document.createElement("div");
        header.className = "viz-card-header";

        const title = document.createElement("span");
        title.textContent = name;

        const type = document.createElement("span");
        type.className = "viz-type";
        type.textContent = descriptor && typeof descriptor.type === "string" ? descriptor.type : "unknown";

        header.append(title, type);
        card.appendChild(header);

        const repr = document.createElement("div");
        repr.className = "viz-repr";
        repr.textContent = descriptor && typeof descriptor.repr === "string" ? descriptor.repr : "";
        card.appendChild(repr);

        if (descriptor && typeof descriptor.numeric === "number" && Number.isFinite(descriptor.numeric)) {
            card.appendChild(createNumericMeter(descriptor.numeric));
        }

        if (descriptor && Array.isArray(descriptor.items) && descriptor.items.length > 0) {
            if (descriptor.kind === "mapping") {
                card.appendChild(createMappingList(descriptor.items));
            } else if (descriptor.kind === "sequence" || descriptor.kind === "set") {
                const chart = createSequenceChart(descriptor.items);
                if (chart) {
                    card.appendChild(chart);
                }
                card.appendChild(createSequenceValues(descriptor.items, descriptor.kind));
            }
        }

        fragment.appendChild(card);
    });

    visualCanvasEl.appendChild(fragment);
    appendTraceNotes();
}

function appendTraceNotes() {
    if (!visualCanvasEl || (!truncated && !timedOut)) {
        return;
    }
    const note = document.createElement("p");
    note.className = "note";
    if (truncated && timedOut) {
        note.textContent = "Trace truncated and execution timed out; visuals may be incomplete.";
    } else if (truncated) {
        note.textContent = "Trace stopped after reaching the maximum number of steps.";
    } else {
        note.textContent = "Execution timed out before completion.";
    }
    visualCanvasEl.appendChild(note);
}

function createNumericMeter(value) {
    const container = document.createElement("div");

    const meter = document.createElement("div");
    meter.className = "viz-meter";

    const bar = document.createElement("div");
    bar.className = "viz-meter-bar";
    const magnitude = Math.min(Math.abs(value), 1000);
    const percent = Math.max(5, (magnitude / 1000) * 100);
    bar.style.width = `${percent}%`;
    if (value < 0) {
        bar.style.background = "linear-gradient(135deg, #ff416c, #ff4b2b)";
    }
    meter.appendChild(bar);

    const label = document.createElement("div");
    label.className = "viz-meter-label";
    label.textContent = `Value: ${value}`;

    container.append(meter, label);
    return container;
}

function createSequenceChart(items) {
    const numericItems = items.filter(item => item && typeof item.numeric === "number" && Number.isFinite(item.numeric));
    if (numericItems.length === 0) {
        return null;
    }

    const maxMagnitude = Math.max(...numericItems.map(item => Math.abs(item.numeric)), 0);
    const chart = document.createElement("div");
    chart.className = "viz-chart";

    numericItems.forEach(item => {
        const bar = document.createElement("div");
        bar.className = "viz-chart-bar";
        const magnitude = Math.abs(item.numeric);
        const height = maxMagnitude === 0 ? 6 : Math.max(6, (magnitude / maxMagnitude) * 100);
        bar.style.height = `${height}%`;
        bar.dataset.label = item.numeric.toString();
        chart.appendChild(bar);
    });

    return chart;
}

function createSequenceValues(items, kind) {
    const container = document.createElement("div");
    container.className = "viz-sequence-values";

    if (!Array.isArray(items) || items.length === 0) {
        const empty = document.createElement("span");
        empty.textContent = "(empty)";
        container.appendChild(empty);
        return container;
    }

    items.forEach((item, index) => {
        const badge = document.createElement("span");
        if (item && item.truncated) {
            badge.textContent = "...";
        } else if (item && typeof item.repr === "string") {
            badge.textContent = kind === "set" ? item.repr : `${index}: ${item.repr}`;
        } else {
            badge.textContent = kind === "set" ? "(?)" : `${index}: (?)`;
        }
        container.appendChild(badge);
    });

    return container;
}

function createMappingList(entries) {
    const container = document.createElement("div");
    container.className = "viz-sequence-values";

    if (!Array.isArray(entries) || entries.length === 0) {
        const empty = document.createElement("span");
        empty.textContent = "(empty)";
        container.appendChild(empty);
        return container;
    }

    entries.forEach(entry => {
        const badge = document.createElement("span");
        if (entry && entry.truncated) {
            badge.textContent = "...";
        } else {
            const key = entry && entry.key && typeof entry.key.repr === "string" ? entry.key.repr : "?";
            const value = entry && entry.value && typeof entry.value.repr === "string" ? entry.value.repr : "?";
            badge.textContent = `${key}: ${value}`;
        }
        container.appendChild(badge);
    });

    return container;
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
renderVisuals(null, "Run the visualizer to see variables change.");
updateProgressBar();

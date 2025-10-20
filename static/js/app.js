const codeInput = document.getElementById("code");
const runBtn = document.getElementById("run-btn");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const statusEl = document.getElementById("status");
const stdoutEl = document.getElementById("stdout");
const errorEl = document.getElementById("error");
const codeLinesEl = document.getElementById("code-lines");
const loadSampleBtn = document.getElementById("load-sample");
const framesContainer = document.getElementById("frames");
const objectsContainer = document.getElementById("objects");
const slider = document.getElementById("step-slider");
const arrowsSvg = document.getElementById("ref-arrows");

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
	renderCodeLines(code);
	renderFramesPlaceholder("Collecting trace...");
	renderObjectsPlaceholder("Collecting trace...");
	updateSlider();

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
			const message = timedOut
				? "Execution timed out before producing a trace."
				: "No trace available. Did your code finish immediately?";
			statusEl.textContent = message;
			renderFramesPlaceholder(message);
			renderObjectsPlaceholder(message);
			updateSlider();
			return;
		}

		currentIndex = 0;
		showStep(trace[currentIndex]);
	} catch (error) {
		console.error(error);
		statusEl.textContent = "Failed to execute code. Check the console for details.";
		errorEl.textContent = error instanceof Error ? error.message : String(error);
		trace = [];
		currentIndex = -1;
		renderFramesPlaceholder("Unable to capture frames.");
		renderObjectsPlaceholder("Unable to capture objects.");
	} finally {
		toggleControls(false);
		updateControls();
	}
}

function toggleControls(isRunning) {
	runBtn.disabled = isRunning;
	prevBtn.disabled = isRunning || currentIndex <= 0;
	nextBtn.disabled = isRunning || trace.length === 0 || currentIndex >= trace.length - 1;
	if (slider) {
		slider.disabled = isRunning || trace.length === 0;
	}
}

function updateControls() {
	prevBtn.disabled = trace.length === 0 || currentIndex <= 0;
	nextBtn.disabled = trace.length === 0 || currentIndex >= trace.length - 1;
	updateSlider();
}

function updateSlider() {
	if (!slider) {
		return;
	}
	if (trace.length === 0 || currentIndex < 0) {
		slider.disabled = true;
		slider.min = 0;
		slider.max = 0;
		slider.value = 0;
		slider.setAttribute("aria-valuetext", "No steps");
		return;
	}
	slider.disabled = false;
	slider.min = 1;
	slider.max = trace.length;
	slider.value = currentIndex + 1;
	slider.setAttribute("aria-valuenow", slider.value);
	slider.setAttribute("aria-valuetext", `Step ${currentIndex + 1} of ${trace.length}`);
}

function buildStatusMessage(step) {
	if (!step || trace.length === 0 || currentIndex < 0) {
		return "No trace loaded.";
	}
	const parts = [`Step ${currentIndex + 1} of ${trace.length}`];
	if (step.event) {
		parts.push(step.event);
	}
	if (typeof step.line === "number") {
		parts.push(`line ${step.line}`);
	}
	if (step.exception && step.exception.type) {
		parts.push(step.exception.type);
	}
	if (truncated) {
		parts.push("trace truncated");
	}
	if (timedOut) {
		parts.push("timed out");
	}
	return parts.join(" - ");
}

function renderCodeLines(code) {
	if (!codeLinesEl) {
		return;
	}
	codeLinesEl.innerHTML = "";
	const lines = code.split("\n");
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
	if (!codeLinesEl) {
		return;
	}
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
	renderFrames(step);
	renderObjects(step.heap);
	statusEl.textContent = buildStatusMessage(step);
	updateSlider();
	drawReferenceArrows();
}

function renderFrames(step) {
	if (!framesContainer) {
		return;
	}
	framesContainer.innerHTML = "";

	const frames = [];
	const globalFrame = {
		title: "Global frame",
		line: null,
		locals: step.globals || {},
		isCurrent: false,
	};
	frames.push(globalFrame);

	let appended = false;
	if (Array.isArray(step.stack) && step.stack.length > 0) {
		step.stack.forEach((frame, index) => {
			const name = frame.function || "<module>";
			if (name === "<module>") {
				return;
			}
			frames.push({
				title: name,
				line: frame.line ?? null,
				locals: frame.locals || {},
				isCurrent: index === step.stack.length - 1,
			});
			appended = true;
		});
	}

	if (!appended) {
		globalFrame.isCurrent = true;
		if (typeof step.line === "number") {
			globalFrame.line = step.line;
		}
	}

	const fragment = document.createDocumentFragment();
	frames.forEach((frame, index) => {
		const card = document.createElement("div");
		card.className = "frame-card";
		if (frame.isCurrent || index === frames.length - 1) {
			card.classList.add("is-current");
		}

		const header = document.createElement("div");
		header.className = "frame-header";
		const title = document.createElement("span");
		title.textContent = frame.title;
		const line = document.createElement("span");
		line.className = "frame-line";
		line.textContent = frame.line ? `line ${frame.line}` : "";
		header.append(title, line);
		card.appendChild(header);

		const varsContainer = document.createElement("div");
		varsContainer.className = "frame-vars";

		const entries = getMappingEntries(frame.locals);
		if (entries.length === 0) {
			const empty = document.createElement("p");
			empty.className = "empty-message";
			empty.textContent = "(no locals)";
			varsContainer.appendChild(empty);
		} else {
			entries.forEach(([name, descriptor]) => {
				varsContainer.appendChild(createVariableRow(name, descriptor));
			});
		}

		card.appendChild(varsContainer);
		fragment.appendChild(card);
	});

	framesContainer.appendChild(fragment);
}

function renderFramesPlaceholder(message) {
	if (!framesContainer) {
		return;
	}
	framesContainer.innerHTML = "";
	const note = document.createElement("p");
	note.className = "empty-message";
	note.textContent = message;
	framesContainer.appendChild(note);
	clearReferenceArrows();
}

function createVariableRow(name, descriptor) {
	const row = document.createElement("div");
	row.className = "frame-var";

	const mainLine = document.createElement("div");
	mainLine.className = "var-row";

	const nameEl = document.createElement("span");
	nameEl.className = "var-name";
	nameEl.textContent = name;

	const valueEl = document.createElement("span");
	valueEl.className = "var-value";

	const reprText = descriptor && typeof descriptor.repr === "string" ? descriptor.repr : "(unavailable)";
	valueEl.textContent = reprText;

	const anchor = document.createElement("span");
	anchor.className = "var-anchor";
	if (!descriptor || !descriptor.ref) {
		anchor.classList.add("is-empty");
	}

	mainLine.append(nameEl, valueEl, anchor);

	if (descriptor && descriptor.ref) {
		valueEl.classList.add("has-ref");
		attachRefHandlers(anchor, descriptor.ref);
		attachRefHandlers(row, descriptor.ref);
		attachRefHandlers(valueEl, descriptor.ref);
		anchor.dataset.refTarget = descriptor.ref;
	}

	row.appendChild(mainLine);

	if (descriptor && descriptor.ref) {
		const meta = document.createElement("div");
		meta.className = "var-meta";
		const typeLabel = descriptor.type || "object";
		meta.textContent = `${typeLabel} ref ${descriptor.ref}`;
		row.appendChild(meta);
		meta.dataset.refTarget = descriptor.ref;
	}

	return row;
}

function getMappingEntries(mapping) {
	if (!mapping || typeof mapping !== "object") {
		return [];
	}
	const entries = Object.entries(mapping);
	entries.sort((a, b) => a[0].localeCompare(b[0]));
	return entries.slice(0, 24);
}

function renderObjects(heap) {
	if (!objectsContainer) {
		return;
	}
	objectsContainer.innerHTML = "";

	if (!heap || typeof heap !== "object" || Object.keys(heap).length === 0) {
		renderObjectsPlaceholder("No heap objects captured.");
		return;
	}

	const entries = Object.entries(heap).sort((a, b) => a[0].localeCompare(b[0]));
	const fragment = document.createDocumentFragment();

	entries.forEach(([ref, descriptor]) => {
		fragment.appendChild(createObjectCard(ref, descriptor));
	});

	if (truncated || timedOut) {
		const note = document.createElement("p");
		note.className = "empty-message";
		if (truncated && timedOut) {
			note.textContent = "Trace truncated and execution timed out; heap may be incomplete.";
		} else if (truncated) {
			note.textContent = "Trace truncated after reaching the step limit.";
		} else {
			note.textContent = "Execution timed out before completion.";
		}
		fragment.appendChild(note);
	}

	objectsContainer.appendChild(fragment);
}

function renderObjectsPlaceholder(message) {
	if (!objectsContainer) {
		return;
	}
	objectsContainer.innerHTML = "";
	const note = document.createElement("p");
	note.className = "empty-message";
	note.textContent = message;
	objectsContainer.appendChild(note);
	clearReferenceArrows();
}

function createObjectCard(ref, descriptor) {
	const card = document.createElement("div");
	card.className = "heap-object";
	attachRefHandlers(card, ref);
	card.dataset.refTarget = ref;

	const header = document.createElement("div");
	header.className = "heap-object-header";
	const typeEl = document.createElement("span");
	typeEl.textContent = descriptor && descriptor.type ? descriptor.type : "object";
	const summaryEl = document.createElement("span");
	summaryEl.className = "heap-type";
	const summaryParts = [];
	if (descriptor && typeof descriptor.length === "number") {
		summaryParts.push(`len ${descriptor.length}`);
	}
	if (descriptor && descriptor.kind && descriptor.kind !== "sequence") {
		summaryParts.push(descriptor.kind);
	}
	summaryEl.textContent = summaryParts.join(" | ");
	header.append(typeEl, summaryEl);
	card.appendChild(header);

	if (descriptor && typeof descriptor.repr === "string") {
		const meta = document.createElement("div");
		meta.className = "heap-meta";
		meta.textContent = descriptor.repr;
		card.appendChild(meta);
	}

	const refEl = document.createElement("div");
	refEl.className = "heap-ref";
	refEl.textContent = ref;
	card.appendChild(refEl);

	if (!descriptor) {
		return card;
	}

	if (descriptor.kind === "sequence" && Array.isArray(descriptor.items)) {
		const list = document.createElement("div");
		list.className = "heap-items";
		descriptor.items.forEach((item, index) => {
			list.appendChild(createSequenceItem(index, item));
		});
		card.appendChild(list);
	} else if (descriptor.kind === "mapping" && Array.isArray(descriptor.entries)) {
		const entries = document.createElement("div");
		entries.className = "heap-entries";
		descriptor.entries.forEach(entry => {
			entries.appendChild(createMappingEntry(entry));
		});
		card.appendChild(entries);
	} else if (descriptor.kind === "set" && Array.isArray(descriptor.items)) {
		const items = document.createElement("div");
		items.className = "heap-items";
		descriptor.items.forEach((item, index) => {
			items.appendChild(createSequenceItem(index, item, true));
		});
		card.appendChild(items);
	} else if (descriptor.kind === "object" && descriptor.attributes) {
		const attributes = document.createElement("div");
		attributes.className = "heap-attributes";
		Object.entries(descriptor.attributes).forEach(([key, value]) => {
			attributes.appendChild(createAttributeRow(key, value));
		});
		card.appendChild(attributes);
	}

	return card;
}

function createSequenceItem(index, item, isSet = false) {
	const row = document.createElement("div");
	row.className = "heap-item";
	const label = document.createElement("span");
	label.className = "heap-label";
	label.textContent = isSet ? "*" : `[${index}]`;
	const value = createInlineDescriptor(item);
	row.append(label, value);
	return row;
}

function createMappingEntry(entry) {
	const row = document.createElement("div");
	row.className = "heap-entry";
	if (!entry || entry.truncated) {
		const truncated = document.createElement("span");
		truncated.className = "inline-descriptor";
		truncated.textContent = "...";
		row.appendChild(truncated);
		return row;
	}
	const key = createInlineDescriptor(entry.key);
	const arrow = document.createElement("span");
	arrow.textContent = ":";
	arrow.className = "heap-label";
	const value = createInlineDescriptor(entry.value);
	row.append(key, arrow, value);
	return row;
}

function createAttributeRow(key, value) {
	const row = document.createElement("div");
	row.className = "heap-attribute";
	const name = document.createElement("span");
	name.className = "heap-label";
	name.textContent = key;
	const descriptor = createInlineDescriptor(value);
	row.append(name, descriptor);
	return row;
}

function createInlineDescriptor(descriptor) {
	const span = document.createElement("span");
	span.className = "inline-descriptor";
	if (!descriptor) {
		span.textContent = "(?)";
		return span;
	}
	if (descriptor.truncated) {
		span.textContent = "...";
		return span;
	}
	if (descriptor.ref) {
		if (descriptor.repr) {
			span.textContent = descriptor.repr;
			span.title = descriptor.ref;
		} else {
			span.textContent = descriptor.ref;
		}
		attachRefHandlers(span, descriptor.ref);
		return span;
	}
	if (typeof descriptor.repr === "string") {
		span.textContent = descriptor.repr;
		return span;
	}
	span.textContent = "(?)";
	return span;
}

function attachRefHandlers(element, ref) {
	if (!element || !ref) {
		return;
	}
	element.dataset.refTarget = ref;
	element.classList.add("ref-target");
	if (!element.hasAttribute("tabindex")) {
		element.tabIndex = 0;
	}
	element.addEventListener("mouseenter", () => toggleRefHighlight(ref, true));
	element.addEventListener("mouseleave", () => toggleRefHighlight(ref, false));
	element.addEventListener("focus", () => toggleRefHighlight(ref, true));
	element.addEventListener("blur", () => toggleRefHighlight(ref, false));
}

function clearReferenceArrows() {
	if (!arrowsSvg) {
		return;
	}
	arrowsSvg.innerHTML = "";
}

function drawReferenceArrows() {
	if (!arrowsSvg) {
		return;
	}
	arrowsSvg.innerHTML = "";

	const container = arrowsSvg.parentElement;
	if (!container) {
		return;
	}

	const sources = framesContainer
		? Array.from(framesContainer.querySelectorAll(".var-anchor[data-ref-target]"))
		: [];

	if (sources.length === 0 || !objectsContainer) {
		return;
	}

	const svgNS = "http://www.w3.org/2000/svg";
	const containerRect = container.getBoundingClientRect();
	arrowsSvg.setAttribute("width", `${containerRect.width}`);
	arrowsSvg.setAttribute("height", `${containerRect.height}`);
	arrowsSvg.setAttribute("viewBox", `0 0 ${containerRect.width} ${containerRect.height}`);

	const defs = document.createElementNS(svgNS, "defs");
	const marker = document.createElementNS(svgNS, "marker");
	marker.setAttribute("id", "arrowhead");
	marker.setAttribute("markerWidth", "10");
	marker.setAttribute("markerHeight", "7");
	marker.setAttribute("refX", "10");
	marker.setAttribute("refY", "3.5");
	marker.setAttribute("orient", "auto");
	marker.setAttribute("markerUnits", "strokeWidth");
	const markerPath = document.createElementNS(svgNS, "path");
	markerPath.setAttribute("d", "M0,0 L10,3.5 L0,7 Z");
	markerPath.setAttribute("fill", "#4da3ff");
	marker.appendChild(markerPath);
	defs.appendChild(marker);
	arrowsSvg.appendChild(defs);

	sources.forEach(source => {
		const ref = source.dataset.refTarget;
		if (!ref) {
			return;
		}
		const target = objectsContainer.querySelector(`.heap-object[data-ref-target='${ref}']`);
		if (!target) {
			return;
		}

		const sourceRect = source.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();

		const startX = sourceRect.right - containerRect.left + 6;
		const startY = sourceRect.top + sourceRect.height / 2 - containerRect.top;
		const endX = targetRect.left - containerRect.left - 6;
		const endY = targetRect.top + targetRect.height / 2 - containerRect.top;
		const controlOffset = Math.max(60, (endX - startX) * 0.3);
		const control1X = startX + controlOffset;
		const control2X = endX - controlOffset * 0.5;

		const path = document.createElementNS(svgNS, "path");
		path.setAttribute("d", `M ${startX} ${startY} C ${control1X} ${startY}, ${control2X} ${endY}, ${endX} ${endY}`);
		path.setAttribute("class", "ref-arrow-path");
		path.setAttribute("marker-end", "url(#arrowhead)");
		arrowsSvg.appendChild(path);

		const circle = document.createElementNS(svgNS, "circle");
		circle.setAttribute("class", "ref-arrow-circle");
		circle.setAttribute("cx", `${startX - 6}`);
		circle.setAttribute("cy", `${startY}`);
		circle.setAttribute("r", "4");
		arrowsSvg.appendChild(circle);
	});
}

function toggleRefHighlight(ref, active) {
	const matches = document.querySelectorAll(`[data-ref-target='${ref}']`);
	matches.forEach(node => {
		if (active) {
			node.classList.add("is-highlighted");
		} else {
			node.classList.remove("is-highlighted");
		}
	});
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

if (slider) {
	slider.addEventListener("input", event => {
		if (trace.length === 0) {
			return;
		}
		const position = Number(event.target.value) - 1;
		if (Number.isNaN(position)) {
			return;
		}
		const clamped = Math.max(0, Math.min(trace.length - 1, position));
		if (clamped === currentIndex) {
			return;
		}
		currentIndex = clamped;
		showStep(trace[currentIndex]);
		updateControls();
	});
}

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

renderCodeLines(codeInput.value);
renderFramesPlaceholder("Run the visualizer to populate frames.");
renderObjectsPlaceholder("Run the visualizer to populate objects.");
updateSlider();
drawReferenceArrows();

window.addEventListener("resize", () => {
	drawReferenceArrows();
});

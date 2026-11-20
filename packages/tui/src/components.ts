import {
	parseColor,
	styleText,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { theme } from "./theme.js";

export { Container, Spacer, Text } from "@earendil-works/pi-tui";

const noColor = (process.env.NO_COLOR ?? "") !== "";

function borderSty(okhsl: string): (s: string) => string {
	if (noColor) return (s) => s;
	const c = parseColor(okhsl);
	return (s) => styleText(s, { fg: c }, "truecolor");
}

const borderMuted = borderSty("okhsl(229 8% 53%)");
const borderDefault = borderSty("okhsl(231 57% 65%)");
const borderAccent = borderSty("okhsl(295 53% 64%)");
const borderError = borderSty("okhsl(20 72% 67%)");
const borderSuccess = borderSty("okhsl(159 59% 67%)");

type BoxMood = "default" | "info" | "accent" | "error" | "success";

function moodBorder(mood: BoxMood): (s: string) => string {
	if (mood === "accent") return borderAccent;
	if (mood === "error") return borderError;
	if (mood === "success") return borderSuccess;
	if (mood === "info") return borderDefault;
	return borderMuted;
}

export class Box implements Component {
	private child: Component;
	private title: string | undefined;
	private paddingX: number;
	private mood: BoxMood;

	constructor(child: Component, opts?: { title?: string; paddingX?: number; mood?: BoxMood }) {
		this.child = child;
		this.title = opts?.title;
		this.paddingX = Math.max(0, opts?.paddingX ?? 1);
		this.mood = opts?.mood ?? "default";
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(6, width);
		const border = moodBorder(this.mood);
		const inner = w - 2;
		const contentW = Math.max(1, inner - this.paddingX * 2);
		const pad = " ".repeat(Math.min(this.paddingX, Math.max(0, Math.floor(inner / 2))));
		let top = "╭─";
		if (this.title !== undefined && this.title !== "") {
			const t = truncateToWidth(this.title, Math.max(1, w - 6), "");
			top += ` ${t} `;
		}
		top += "─".repeat(Math.max(0, w - visibleWidth(top) - 1)) + "╮";
		const rows = [border(truncateToWidth(top, w, ""))];
		for (const line of this.child.render(contentW)) {
			const t = truncateToWidth(line, contentW, "");
			const fill = " ".repeat(Math.max(0, contentW - visibleWidth(t)));
			rows.push(border("│") + pad + t + fill + pad + border("│"));
		}
		rows.push(border("╰" + "─".repeat(Math.max(1, w - 2)) + "╯"));
		return rows;
	}
}

export class StatusBar implements Component {
	private segments: string[] = [];

	setSegments(segments: string[]): void {
		this.segments = segments;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(0, width);
		if (this.segments.length === 0) return [""];
		const joined = this.segments.join(theme.muted(" │ "));
		const padded = ` ${joined} `;
		return [truncateToWidth(theme.muted("▏") + padded, w, "")];
	}
}

export class ToolCard implements Component {
	private outputs: string[] = [];
	private done = false;
	private failed = false;
	private readonly maxLines: number;
	private readonly toolName: string;
	private readonly argsSummary: string;
	private expanded = false;

	constructor(toolName: string, argsSummary: string, opts?: { maxLines?: number; expanded?: boolean }) {
		this.toolName = toolName;
		this.argsSummary = argsSummary;
		this.maxLines = Math.max(0, opts?.maxLines ?? 200);
		this.expanded = opts?.expanded ?? false;
	}

	appendOutput(text: string): void {
		if (!text) return;
		for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
			this.outputs.push(line.trimEnd());
			if (this.outputs.length > 400) this.outputs.splice(0, this.outputs.length - 400);
		}
	}

	hasOutput(): boolean {
		return this.outputs.some((l) => l.trim() !== "");
	}

	finish(failed = false): void {
		this.done = true;
		this.failed = failed;
		// Auto-expand edit/write results with useful details (diffs/content summaries) for OpenCode-like visibility.
		if (!failed && (this.toolName === "edit" || this.toolName === "write") && this.hasOutput()) {
			this.expanded = true;
		}
	}

	isFailed(): boolean {
		return this.failed;
	}

	isDone(): boolean {
		return this.done;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y !== 0) return undefined;
		if (event.type !== "click") return undefined;
		// While running, keep the running state visible; expand/collapse applies once settled.
		if (!this.done) return { handled: true, render: false };
		const hasOutput = this.outputs.some((l) => l.trim() !== "") || this.failed;
		if (!hasOutput) return { handled: true, render: false };
		this.expanded = !this.expanded;
		return { handled: true, render: true };
	}

	invalidate(): void {}

	private displayLabel(): string {
		const target = this.argsSummary.trim();
		if (this.toolName === "write" && target) return `Wrote ${target}`;
		if (this.toolName === "edit" && target) return `Edited ${target}`;
		return target ? `${this.toolName} ${target}` : this.toolName;
	}

	private formatOutputLine(line: string): string {
		if (this.toolName === "edit") {
			if (line.startsWith("+") && !line.startsWith("+++")) return theme.success(`    ${line}`);
			if (line.startsWith("-") && !line.startsWith("---")) return theme.error(`    ${line}`);
			if (line.startsWith("@@")) return theme.accent(`    ${line}`);
		}
		return theme.tool(`    ${line}`);
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const summary = this.displayLabel();
		const hasOutput = this.outputs.some((l) => l.trim() !== "") || this.failed;
		const canToggle = this.done && hasOutput;
		const toggle = canToggle ? (this.expanded ? theme.muted("[-] ") : theme.muted("[+] ")) : "    ";
		let header: string;
		if (!this.done) {
			header = `${theme.accent("◈")} ${theme.muted(summary)} ${theme.muted("running…")}`;
		} else if (this.failed) header = `${toggle}${theme.error("✖")} ${theme.bold(summary)}`;
		else header = `${toggle}${theme.success("✔")} ${theme.bold(summary)}`;
		const rows = [truncateToWidth(header, w, "")];
		if (!this.done) {
			const nonEmpty = this.outputs.map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
			if (nonEmpty.length > 0) {
				const liveTail = nonEmpty.slice(-6);
				for (const line of liveTail) {
					rows.push(truncateToWidth(this.formatOutputLine(line), w, ""));
				}
			} else {
				rows.push(truncateToWidth(theme.muted("    tool running…"), w, ""));
			}
			return rows;
		}
		if (!hasOutput) return rows;
		if (!this.expanded) {
			const hint = this.failed ? "click header to expand error/output details" : "click header to expand output";
			rows.push(truncateToWidth(theme.muted(`    ${hint}`), w, ""));
			return rows;
		}
		const visible = this.outputs.slice(Math.max(0, this.outputs.length - this.maxLines));
		let printed = 0;
		for (const line of visible) {
			const compact = line.trimEnd();
			if (compact.trim() === "") continue;
			rows.push(truncateToWidth(this.formatOutputLine(compact), w, ""));
			printed++;
		}
		if (printed === 0) {
			rows.push(truncateToWidth(this.failed ? theme.error("    failed with no output") : theme.muted("    (no output)"), w, ""));
		} else if (this.outputs.length > visible.length) {
			rows.push(truncateToWidth(theme.muted(`    … (${this.outputs.length - visible.length} earlier lines hidden)`), w, ""));
		}
		return rows;
	}
}

export class CollapsibleText implements Component {
	private text = "";
	private expanded = false;
	private readonly label: string;
	private readonly style: (s: string) => string;
	private streaming = false;

	constructor(label: string, opts?: { expanded?: boolean; style?: (s: string) => string; streaming?: boolean }) {
		this.label = label;
		this.expanded = opts?.expanded ?? false;
		this.style = opts?.style ?? ((s) => s);
		this.streaming = opts?.streaming ?? false;
	}

	setText(text: string): void {
		this.text = text;
	}

	appendText(text: string): void {
		this.text += text;
	}

	getText(): string {
		return this.text;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setStreaming(streaming: boolean): void {
		this.streaming = streaming;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y !== 0) return undefined;
		if (event.type !== "click") return undefined;
		this.expanded = !this.expanded;
		return { handled: true, render: true };
	}

	invalidate(): void {}

	private previewTitle(): string {
		const lines = this.text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
		if (lines.length === 0) return "";
		const first = lines[0] ?? "";
		const compact = first.replace(/\s+/g, " ").trim();
		if (!compact) return "";
		return compact.length > 60 ? `${compact.slice(0, 60)}…` : compact;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const hasContent = this.text.trim().length > 0;
		const prefix = this.streaming ? theme.accent("◈ ") : this.expanded ? theme.muted("[-] ") : theme.muted("[+] ");
		const preview = hasContent ? this.previewTitle() : "";
		let suffix = "";
		if (this.streaming) {
			suffix = preview ? theme.muted(` · ${preview}`) : theme.muted(" running…");
		} else if (!hasContent) {
			suffix = theme.muted(" (empty)");
		} else if (preview) {
			suffix = theme.muted(` · ${preview}`);
		}
		const header = `${prefix}${theme.muted(this.label)}${suffix}`;
		const rows = [truncateToWidth(header, w, "")];
		if (!this.expanded || !hasContent) return rows;
		for (const line of this.text.replace(/\r\n/g, "\n").split("\n")) {
			rows.push(truncateToWidth(this.style(`    ${line}`), w, ""));
		}
		return rows;
	}
}

export class Rule implements Component {
	private readonly char: string;

	constructor(char = "─") {
		this.char = char === "" ? "─" : char;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(1, width);
		let s = "";
		let guard = 0;
		while (visibleWidth(s) < w && guard < w + 4) {
			s += this.char;
			guard += 1;
		}
		return [theme.muted(truncateToWidth(s, w, ""))];
	}
}

export interface SidebarSection {
	key: string;
	title: string;
	lines: string[];
	collapsible?: boolean;
	defaultExpanded?: boolean;
}

export class SidebarPanel implements Component {
	private sections: SidebarSection[] = [];
	private collapsed = new Set<string>();
	private headerRows = new Map<number, string>();
	private initialized = new Set<string>();
	private readonly leftBorder: boolean;

	constructor(opts?: { leftBorder?: boolean }) {
		this.leftBorder = opts?.leftBorder ?? false;
	}

	setSections(sections: SidebarSection[]): void {
		this.sections = sections;
		for (const s of sections) {
			if (this.initialized.has(s.key)) continue;
			this.initialized.add(s.key);
			if (s.collapsible && s.defaultExpanded === false) this.collapsed.add(s.key);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click") return undefined;
		const key = this.headerRows.get(event.y);
		if (!key) return undefined;
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.headerRows.clear();
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const prefix = this.leftBorder ? theme.muted("│ ") : "";
		const innerW = Math.max(1, w - visibleWidth(prefix));
		const rows: string[] = [];
		this.headerRows.clear();
		const pushWrapped = (line: string, trackHeaderKey?: string, continuationIndent = "  ") => {
			if (trackHeaderKey !== undefined) this.headerRows.set(rows.length, trackHeaderKey);
			const wrapped = wrapTextWithAnsi(line, innerW);
			if (wrapped.length === 0) {
				rows.push(prefix);
				return;
			}
			wrapped.forEach((segment, i) => {
				if (i === 0) rows.push(prefix + segment);
				else rows.push(prefix + continuationIndent + truncateToWidth(segment, Math.max(1, innerW - visibleWidth(continuationIndent)), ""));
			});
		};
		for (const section of this.sections) {
			const collapsible = section.collapsible ?? false;
			const isCollapsed = collapsible && this.collapsed.has(section.key);
			const marker = collapsible ? (isCollapsed ? theme.muted("[+] ") : theme.muted("[-] ")) : "";
			const header = `${marker}${theme.bold(section.title)}`;
			pushWrapped(header, section.key);
			if (isCollapsed) continue;
			for (const line of section.lines) {
				pushWrapped(line);
			}
			if (section.lines.length > 0) rows.push(prefix);
		}
		while (rows.length > 0 && rows[rows.length - 1] === prefix) rows.pop();
		return rows;
	}
}

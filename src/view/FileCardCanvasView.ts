import {
	App,
	FileView,
	WorkspaceLeaf,
	TFile,
	CachedMetadata,
	Notice,
	parseFrontMatterTags,
} from "obsidian";
import type {
	CanvasData,
	CanvasFileData,
	CanvasTextData,
	CanvasGroupData,
	CanvasEdgeData,
	AllCanvasNodeData,
	NodeShape,
	NodeSide,
} from "../types";
export const FILE_CARD_CANVAS_VIEW_TYPE = "file-card-canvas";
export const HCANVAS_EXT = "hcanvas";

const LONG_PRESS_MS = 150;
const DRAG_THRESHOLD_PX = 5;
const CANVAS_SIZE_PX = 120000;
const MIN_NODE_WIDTH = 160;
const MIN_NODE_HEIGHT = 80;

const CANVAS_COLORS: Record<string, string> = {
	1: "var(--color-red)",
	2: "var(--color-orange)",
	3: "var(--color-yellow)",
	4: "var(--color-green)",
	5: "var(--color-cyan)",
	6: "var(--color-purple)",
};

const DEFAULT_CANVAS_DATA: CanvasData = {
	nodes: [],
	edges: [],
};

type PluginWithSettings = {
	settings: { defaultCanvasFolder?: string };
	saveSettings: () => Promise<void>;
};

export class FileCardCanvasView extends FileView {
	static readonly HCANVAS_EXT = "hcanvas";
	private canvasStageEl: HTMLElement | null = null;
	private nodesContainer: HTMLElement;
	private edgesContainer: SVGElement;
	private draggedNodeId: string | null = null;
	private dragOffset = { x: 0, y: 0 };
	private zoom = 1;
	private pan = { x: 0, y: 0 };
	private isPanning = false;
	private panStart = { x: 0, y: 0 };
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private nodeMouseDownPos: { x: number; y: number } | null = null;
	private nodeMouseDownId: string | null = null;
	private didDragThisPointer = false;
	private selectedNodeId: string | null = null;
	private selectedNodeWrapper: HTMLElement | null = null;
	private selectedSubmenuEl: HTMLElement | null = null;
	private edgeFrom: { nodeId: string; side: NodeSide; dotEl: HTMLElement } | null = null;
	private edgeLineEl: SVGPathElement | null = null;
	private tempEdgeContainer: SVGElement | null = null;
	private draggedEdgeControlId: string | null = null;
	private draggedEdgeControlPointerOffset = { x: 0, y: 0 };
	private isRenameWatcherBound = false;
	private edgeLabelEditorEl: HTMLElement | null = null;
	private isDetailLeafWatcherBound = false;
	private resizeState:
		| {
			nodeId: string;
			dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
			startX: number;
			startY: number;
			startNodeX: number;
			startNodeY: number;
			startWidth: number;
			startHeight: number;
			wrapper: HTMLElement;
			nodeEl: HTMLElement;
			node: AllCanvasNodeData;
		}
		| null = null;
	/** Single detail pane for file preview from canvas */
	private detailLeaf: WorkspaceLeaf | null = null;

	private canvasData: CanvasData = { ...DEFAULT_CANVAS_DATA };

	constructor(
		leaf: WorkspaceLeaf,
		readonly app: App,
		private readonly plugin: PluginWithSettings
	) {
		super(leaf);
	}

	getViewType(): string {
		return FILE_CARD_CANVAS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "File card canvas";
	}

	getIcon(): string {
		return "layout-grid";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === FileCardCanvasView.HCANVAS_EXT;
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.bindVaultRenameWatcher();
		this.bindDetailLeafWatcher();
		await this.loadCanvasData();
		this.renderCanvas();
	}

	async onUnloadFile(): Promise<void> {
		this.clearLongPressTimer();
		this.closeEdgeLabelEditor();
		this.closeDetailLeaf();
		await this.saveCanvasData();
	}

	async onRename(): Promise<void> {
		// File rename handled by Obsidian; no extra action needed
	}

	private bindVaultRenameWatcher(): void {
		if (this.isRenameWatcherBound) return;
		this.isRenameWatcherBound = true;
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile) || !oldPath) return;
			let changed = false;
			for (const node of this.canvasData.nodes) {
				if (node.type === "file" && (node as CanvasFileData).file === oldPath) {
					(node as CanvasFileData).file = file.path;
					changed = true;
				}
			}
			if (!changed) return;
			this.renderCanvas();
			this.saveCanvasData();
		}));
	}

	private bindDetailLeafWatcher(): void {
		if (this.isDetailLeafWatcherBound) return;
		this.isDetailLeafWatcherBound = true;
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			if (!this.detailLeaf) return;
			let stillThere = false;
			this.app.workspace.iterateAllLeaves((l) => {
				if (l === this.detailLeaf) stillThere = true;
			});
			if (!stillThere) {
				const selectedId = this.selectedNodeId;
				this.detailLeaf = null;
				if (selectedId) this.refreshNodeCardById(selectedId);
			}
		}));
	}

	private async loadCanvasData(): Promise<void> {
		if (!this.file) {
			this.canvasData = { ...DEFAULT_CANVAS_DATA };
			return;
		}
		try {
			const raw = await this.app.vault.read(this.file);
			const parsed = JSON.parse(raw) as Partial<CanvasData>;
			this.canvasData = {
				nodes: parsed.nodes ?? [],
				edges: parsed.edges ?? [],
			};
		} catch {
			this.canvasData = { ...DEFAULT_CANVAS_DATA };
		}
	}

	private async saveCanvasData(): Promise<void> {
		if (!this.file) return;
		await this.app.vault.modify(this.file, JSON.stringify(this.canvasData, null, 2));
	}

	private clearLongPressTimer(): void {
		if (this.longPressTimer) {
			clearTimeout(this.longPressTimer);
			this.longPressTimer = null;
		}
	}

	private renderCanvas(): void {
		this.closeEdgeLabelEditor();
		this.contentEl.empty();
		this.contentEl.addClass("heinibal-file-card-canvas-container");
		this.contentEl.style.setProperty("--heinibal-canvas-size", `${CANVAS_SIZE_PX}px`);

		const toolbar = this.contentEl.createDiv({ cls: "heinibal-canvas-toolbar" });
		toolbar.createEl("button", { text: "Add files" }).onclick = () => this.showAddFilesModal();
		toolbar.createEl("button", { text: "Add group" }).onclick = () => this.addGroup();
		toolbar.createEl("button", { text: "New canvas", title: "Create new canvas file" }).onclick = () => this.createNewCanvasFile();

		const viewport = this.contentEl.createDiv({ cls: "heinibal-canvas-viewport" });
		this.canvasStageEl = viewport.createDiv({ cls: "heinibal-canvas-stage" });

		this.edgesContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.edgesContainer.addClass("heinibal-canvas-edges");
		this.edgesContainer.setAttribute("width", String(CANVAS_SIZE_PX));
		this.edgesContainer.setAttribute("height", String(CANVAS_SIZE_PX));
		this.edgesContainer.setAttribute("overflow", "visible");
		this.canvasStageEl.appendChild(this.edgesContainer);

		this.nodesContainer = this.canvasStageEl.createDiv({ cls: "heinibal-canvas-nodes" });
		this.nodesContainer.style.width = `${CANVAS_SIZE_PX}px`;
		this.nodesContainer.style.height = `${CANVAS_SIZE_PX}px`;

		this.renderEdges();
		for (const node of this.canvasData.nodes) {
			this.renderNode(node);
		}

		this.registerDomEvent(this.contentEl, "wheel", (e: WheelEvent) => {
			e.preventDefault();
			const before = this.clientToCanvas(e.clientX, e.clientY);
			this.zoom = Math.max(0.2, Math.min(4, this.zoom - e.deltaY * 0.001));
			const viewportRect = viewport.getBoundingClientRect();
			this.pan.x = e.clientX - viewportRect.left - before.x * this.zoom;
			this.pan.y = e.clientY - viewportRect.top - before.y * this.zoom;
			this.updateViewportTransform();
		});

		this.registerDomEvent(viewport, "mousedown", (e: MouseEvent) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement | null;
			const inNode = target?.closest(".heinibal-node-wrapper");
			const inMenu = target?.closest(".heinibal-card-submenu") || target?.closest(".heinibal-context-menu");
			const inToolbar = target?.closest(".heinibal-canvas-toolbar");
			if (!inNode && !inMenu && !inToolbar) {
				this.isPanning = true;
				this.panStart = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
			}
		});

		this.registerDomEvent(this.contentEl, "mousedown", (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			const inNode = target.closest(".heinibal-node-wrapper");
			const inMenu = target.closest(".heinibal-card-submenu") || target.closest(".heinibal-context-menu");
			if (!inNode && !inMenu) return;
		});

		this.registerDomEvent(document, "mousedown", (e: MouseEvent) => {
			const target = e.target as Node | null;
			if (target && !this.contentEl.contains(target)) {
				this.hideSubmenu();
				this.clearSelection();
			}
		});

		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if ((e.key !== "Delete" && e.key !== "Backspace") || !this.selectedNodeId) return;
			if (this.isTypingTarget(e.target)) return;
			e.preventDefault();
			this.deleteNodeById(this.selectedNodeId);
		});

		this.registerDomEvent(document, "mousemove", (e: MouseEvent) => {
			if (this.resizeState) {
				this.applyNodeResize(e);
				return;
			}
			if (this.isPanning) {
				this.pan = { x: e.clientX - this.panStart.x, y: e.clientY - this.panStart.y };
				this.updateViewportTransform();
			}
				if (this.draggedEdgeControlId) {
					const edge = this.canvasData.edges.find((it) => it.id === this.draggedEdgeControlId);
					if (edge) {
						const pos = this.clientToCanvas(e.clientX, e.clientY);
						edge.controlX = pos.x - this.draggedEdgeControlPointerOffset.x;
						edge.controlY = pos.y - this.draggedEdgeControlPointerOffset.y;
						this.renderEdges();
					}
				}
			if (this.edgeFrom) {
				this.updateTempEdge(e);
			}
		});

		this.registerDomEvent(document, "mouseup", (e: MouseEvent) => {
			const hadNodeDrag = this.draggedNodeId !== null;
			if (this.resizeState) {
				this.resizeState = null;
				this.saveCanvasData();
			}
			if (this.edgeFrom) {
					const wrapper = document.elementFromPoint(e.clientX, e.clientY)?.closest(".heinibal-node-wrapper");
					const toNodeId = wrapper?.getAttribute("data-node-id") ?? null;
					if (toNodeId && toNodeId !== this.edgeFrom.nodeId) {
						const toNode = this.canvasData.nodes.find((n) => n.id === toNodeId);
						const fromNode = this.canvasData.nodes.find((n) => n.id === this.edgeFrom!.nodeId);
						if (toNode && fromNode) {
							const pos = this.clientToCanvas(e.clientX, e.clientY);
							const dropCanvasX = pos.x;
							const dropCanvasY = pos.y;
							const { side: toSide, offset: toOffset } = this.getPointOnNodeBorder(toNode, dropCanvasX, dropCanvasY);
							this.canvasData.edges.push({
								id: "edge-" + Date.now(),
							fromNode: this.edgeFrom.nodeId,
							fromSide: this.edgeFrom.side,
							fromOffset: 0.5,
							toNode: toNodeId,
							toSide,
							toOffset,
						});
						this.renderEdges();
						this.saveCanvasData();
					}
				}
				this.finishEdge();
			}
			if (this.draggedEdgeControlId) {
				this.draggedEdgeControlId = null;
				this.saveCanvasData();
			}
			this.isPanning = false;
			this.draggedNodeId = null;
			if (hadNodeDrag) {
				this.saveCanvasData();
			}
		});

		this.setupDropZone(this.contentEl);

		this.updateViewportTransform();
	}

	private updateViewportTransform(): void {
		if (this.canvasStageEl instanceof HTMLElement) {
			this.canvasStageEl.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
		}
	}

	private async createNewCanvasFile(): Promise<void> {
		const folder = (this.plugin.settings.defaultCanvasFolder ?? "").trim() || undefined;
		const base = "Untitled Canvas";
		let name = `${base}.${FileCardCanvasView.HCANVAS_EXT}`;
		let n = 0;
		while (this.app.vault.getAbstractFileByPath(folder ? `${folder}/${name}` : name)) {
			n++;
			name = `${base} ${n}.${FileCardCanvasView.HCANVAS_EXT}`;
		}
		const path = folder ? `${folder}/${name}` : name;
		const file = await this.app.vault.create(path, JSON.stringify(DEFAULT_CANVAS_DATA, null, 2));
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.openFile(file);
	}

	private setupDropZone(dropTarget: HTMLElement): void {
		this.registerDomEvent(dropTarget, "dragover", (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			dropTarget.addClass("heinibal-dropzone-active");
		});
		this.registerDomEvent(dropTarget, "dragleave", (e: DragEvent) => {
			if (!dropTarget.contains(e.relatedTarget as Node)) {
				dropTarget.removeClass("heinibal-dropzone-active");
			}
		});
		this.registerDomEvent(dropTarget, "drop", async (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			dropTarget.removeClass("heinibal-dropzone-active");
			const dropPos = this.clientToCanvas(e.clientX, e.clientY);
			const tokens = await this.getDroppedPaths(e);
			const added = new Set<string>();
			const duplicated = new Set<string>();
			const existingPaths = new Set(
				this.canvasData.nodes
					.filter((n): n is CanvasFileData => n.type === "file")
					.map((n) => n.file)
			);
			let index = 0;
			for (const token of tokens) {
				const file = this.resolveDroppedMarkdownFile(token);
				if (file && !added.has(file.path)) {
					if (existingPaths.has(file.path)) {
						duplicated.add(file.path);
						continue;
					}
					this.addFileToCanvas(file, {
						x: dropPos.x + index * 26,
						y: dropPos.y + index * 26,
					});
					index++;
					added.add(file.path);
					existingPaths.add(file.path);
				}
			}
			if (added.size === 0) {
				const normalized = tokens
					.map((t) => t.trim().toLowerCase())
					.filter((t) => t.length > 0);
				const markdownFiles = this.app.vault.getMarkdownFiles();
				for (const mf of markdownFiles) {
					const pathLower = mf.path.toLowerCase();
					const nameLower = mf.name.toLowerCase();
					const baseLower = mf.basename.toLowerCase();
					const matched = normalized.some((t) =>
						t.includes(pathLower) || t.includes(nameLower) || t.includes(baseLower)
					);
					if (matched && !added.has(mf.path)) {
						if (existingPaths.has(mf.path)) {
							duplicated.add(mf.path);
							continue;
						}
						this.addFileToCanvas(mf, {
							x: dropPos.x + index * 26,
							y: dropPos.y + index * 26,
						});
						index++;
						added.add(mf.path);
						existingPaths.add(mf.path);
					}
				}
			}
			if (added.size > 0) this.saveCanvasData();
			if (duplicated.size > 0) {
				const count = duplicated.size;
				new Notice(`File already exists on canvas (${count})`, 2500);
			}
		});
	}

	private async getDroppedPaths(e: DragEvent): Promise<string[]> {
		const out = new Set<string>();
		const pushToken = (v: unknown): void => {
			if (typeof v !== "string") return;
			const s = v.trim();
			if (s) out.add(s);
		};
			const extractFromText = (text: string): void => {
				if (!text) return;
				pushToken(text);
				for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[\]|#]|$)/g)) pushToken(m[1]);
				for (const m of text.matchAll(/(?:^|[\s(])([^)\s]+\.md)(?:$|[\s)])/gi)) pushToken(m[1]);
				for (const m of text.matchAll(/file=([^&\s]+)/gi)) {
					const hit = m[1];
					if (hit) pushToken(this.safeDecodeURIComponent(hit));
				}
			};
		const collectJsonValues = (v: unknown): void => {
			if (typeof v === "string") {
				extractFromText(v);
				return;
			}
			if (Array.isArray(v)) {
				for (const item of v) collectJsonValues(item);
				return;
			}
			if (v && typeof v === "object") {
				const obj = v as Record<string, unknown>;
				for (const key of ["path", "file", "name", "basename", "value"]) {
					if (key in obj) collectJsonValues(obj[key]);
				}
			}
		};

		try {
			const dt = e.dataTransfer;
			const types = dt?.types ?? [];
			for (const type of types) {
				const raw = dt?.getData(type);
				if (!raw) continue;

				if (type === "text/plain") {
					extractFromText(raw);
					continue;
				}

				if (type === "text/uri-list") {
					for (const line of raw.split(/\r?\n/)) {
						const s = line.trim();
						if (s && !s.startsWith("#")) extractFromText(s);
					}
					continue;
				}

				if (type === "application/x-obsidian-file") {
					try {
						collectJsonValues(JSON.parse(raw));
					} catch {
						pushToken(raw);
					}
					continue;
				}

				extractFromText(raw);
			}

			const items = dt?.items ? Array.from(dt.items) : [];
			await Promise.all(
				items
					.filter((it) => it.kind === "string")
					.map(
						(it) =>
							new Promise<void>((resolve) => {
								try {
									it.getAsString((s) => {
										if (s) {
											extractFromText(s);
											try {
												collectJsonValues(JSON.parse(s));
											} catch {}
										}
										resolve();
									});
								} catch {
									resolve();
								}
							})
					)
			);

			if (dt?.files?.length) {
				for (const f of Array.from(dt.files)) {
					const pathLike = ((f as File & { path?: string }).path ?? f.name).trim();
					extractFromText(pathLike);
				}
			}
		} catch {}

		return [...out];
	}

	private resolveDroppedMarkdownFile(token: string): TFile | null {
		const raw = token.trim();
		if (!raw) return null;

		let normalizedToken = raw;
		if (raw.startsWith("obsidian://")) {
			try {
				const url = new URL(raw);
				const fileParam = url.searchParams.get("file");
				if (fileParam) normalizedToken = fileParam;
			} catch {}
		}

		const clean = normalizedToken
			.trim()
			.replace(/^file:\/\//i, "")
			.replace(/^["']|["']$/g, "")
			.replace(/\\/g, "/");
		const decoded = this.safeDecodeURIComponent(clean);

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const candidates = new Set<string>();
		const base = decoded.replace(/^\/+/, "");
		const baseLower = base.toLowerCase();

		candidates.add(base);
		if (!base.endsWith(".md")) candidates.add(`${base}.md`);

		const wikiMatch = base.match(/\[\[([^\]|#]+)(?:[\]|#]|$)/);
		if (wikiMatch?.[1]) {
			const w = wikiMatch[1].trim();
			candidates.add(w);
			if (!w.endsWith(".md")) candidates.add(`${w}.md`);
		}

		for (const c of candidates) {
			const direct = this.app.vault.getAbstractFileByPath(c);
			if (direct instanceof TFile && direct.extension === "md") return direct;
		}

		const nameLike = base.split("/").pop() ?? base;
		const nameWithExt = nameLike.endsWith(".md") ? nameLike : `${nameLike}.md`;
		const nameNoExt = nameLike.replace(/\.md$/i, "");
		const nameWithExtLower = nameWithExt.toLowerCase();
		const nameNoExtLower = nameNoExt.toLowerCase();

		return (
			markdownFiles.find((f) => f.path.toLowerCase() === baseLower) ??
			markdownFiles.find((f) => f.path.toLowerCase().endsWith("/" + baseLower)) ??
			markdownFiles.find((f) => f.name.toLowerCase() === nameWithExtLower) ??
			markdownFiles.find((f) => f.basename.toLowerCase() === nameNoExtLower) ??
			markdownFiles.find((f) => baseLower.includes(f.path.toLowerCase())) ??
			markdownFiles.find((f) => baseLower.includes(f.name.toLowerCase())) ??
			null
		);
	}

	private safeDecodeURIComponent(value: string): string {
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}

	private renderEdges(): void {
		this.edgesContainer.empty();
		const svgNS = "http://www.w3.org/2000/svg";
		const data = this.canvasData;

		for (const edge of data.edges) {
			const fromNode = data.nodes.find((n) => n.id === edge.fromNode);
			const toNode = data.nodes.find((n) => n.id === edge.toNode);
			if (!fromNode || !toNode) continue;

			const fromPt = this.getNodeSidePoint(
				fromNode,
				edge.fromSide ?? "right",
				edge.fromOffset ?? 0.5
			);
			const toPt = this.getNodeSidePoint(
				toNode,
				edge.toSide ?? "left",
				edge.toOffset ?? 0.5
			);
			const curve = this.getEdgeCurve(edge, fromPt, toPt);
			const d = curve.type === "manual"
				? `M ${fromPt.x} ${fromPt.y} Q ${curve.cx} ${curve.cy} ${toPt.x} ${toPt.y}`
				: `M ${fromPt.x} ${fromPt.y} C ${curve.c1x} ${curve.c1y} ${curve.c2x} ${curve.c2y} ${toPt.x} ${toPt.y}`;
			const labelPt = curve.type === "manual"
				? { x: curve.midX, y: curve.midY }
				: this.getCubicPoint(
					fromPt,
					{ x: curve.c1x, y: curve.c1y },
					{ x: curve.c2x, y: curve.c2y },
					toPt,
					0.5
				);
			const handlePt = curve.type === "manual"
				? { x: curve.midX, y: curve.midY }
				: this.getCubicPoint(
					fromPt,
					{ x: curve.c1x, y: curve.c1y },
					{ x: curve.c2x, y: curve.c2y },
					toPt,
					0.5
				);

			const g = document.createElementNS(svgNS, "g");
			g.dataset.edgeId = edge.id;

			const hitPath = document.createElementNS(svgNS, "path");
			hitPath.setAttribute("d", d);
			hitPath.setAttribute("fill", "none");
			hitPath.setAttribute("stroke", "transparent");
			hitPath.setAttribute("stroke-width", "16");
			hitPath.setAttribute("class", "heinibal-edge-path");
			hitPath.style.pointerEvents = "stroke";
			hitPath.style.cursor = "pointer";
			g.appendChild(hitPath);

			const path = document.createElementNS(svgNS, "path");
			const color = this.resolveColor(edge.color);
			path.setAttribute("d", d);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", color);
			path.setAttribute("stroke-width", "2");
			path.setAttribute("marker-end", "url(#arrowhead)");
			path.setAttribute("class", "heinibal-edge-path-visible");
			path.style.pointerEvents = "none";
			g.appendChild(path);

			const text = document.createElementNS(svgNS, "text");
			text.setAttribute("x", String(labelPt.x));
			text.setAttribute("y", String(labelPt.y));
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("dominant-baseline", "middle");
				text.setAttribute("class", "heinibal-edge-label");
				text.setAttribute("font-size", "12");
				text.textContent = edge.label ?? "";
				text.style.cursor = "text";
				text.addEventListener("dblclick", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					this.openEdgeLabelEditor(edge, ev.clientX, ev.clientY);
				});
				g.appendChild(text);

				const handle = document.createElementNS(svgNS, "circle");
				handle.setAttribute("cx", String(handlePt.x));
				handle.setAttribute("cy", String(handlePt.y));
				handle.setAttribute("r", "8");
			handle.setAttribute("class", "heinibal-edge-handle");
			handle.style.pointerEvents = "all";
			handle.style.cursor = "grab";
			handle.addEventListener("mousedown", (ev: MouseEvent) => {
				ev.preventDefault();
				ev.stopPropagation();
				const pos = this.clientToCanvas(ev.clientX, ev.clientY);
				this.draggedEdgeControlPointerOffset = {
					x: pos.x - handlePt.x,
					y: pos.y - handlePt.y,
				};
				edge.controlX = handlePt.x;
				edge.controlY = handlePt.y;
				this.draggedEdgeControlId = edge.id;
			});
			g.appendChild(handle);

			hitPath.addEventListener("contextmenu", (ev: MouseEvent) => {
				ev.preventDefault();
				this.canvasData.edges = this.canvasData.edges.filter((it) => it.id !== edge.id);
				this.renderEdges();
				this.saveCanvasData();
			});
			hitPath.addEventListener("dblclick", (ev: MouseEvent) => {
				ev.preventDefault();
				this.openEdgeLabelEditor(edge, ev.clientX, ev.clientY);
			});
			this.edgesContainer.appendChild(g);
		}

		const defs = document.createElementNS(svgNS, "defs");
		const marker = document.createElementNS(svgNS, "marker");
		marker.setAttribute("id", "arrowhead");
		marker.setAttribute("markerWidth", "10");
		marker.setAttribute("markerHeight", "7");
		marker.setAttribute("refX", "9");
		marker.setAttribute("refY", "3.5");
		marker.setAttribute("orient", "auto");
		const poly = document.createElementNS(svgNS, "polygon");
		poly.setAttribute("points", "0 0, 10 3.5, 0 7");
		poly.setAttribute("fill", "context-stroke");
		marker.appendChild(poly);
		defs.appendChild(marker);
		this.edgesContainer.prepend(defs);
	}

	private getEdgeCurve(
		edge: CanvasEdgeData,
		fromPt: { x: number; y: number },
		toPt: { x: number; y: number }
	):
		| { type: "manual"; midX: number; midY: number; cx: number; cy: number }
		| { type: "auto"; c1x: number; c1y: number; c2x: number; c2y: number } {
		if (typeof edge.controlX === "number" && typeof edge.controlY === "number") {
			const midX = edge.controlX;
			const midY = edge.controlY;
			const control = this.getQuadraticControlThroughMid(fromPt, toPt, { x: midX, y: midY });
			return { type: "manual", midX, midY, cx: control.x, cy: control.y };
		}
		const fromNormal = this.getSideNormal(edge.fromSide ?? "right");
		const toNormal = this.getSideNormal(edge.toSide ?? "left");
		const dx = toPt.x - fromPt.x;
		const dy = toPt.y - fromPt.y;
		const distance = Math.hypot(dx, dy);
		const strength = Math.max(40, Math.min(220, distance * 0.35));
		return {
			type: "auto",
			c1x: fromPt.x + fromNormal.x * strength,
			c1y: fromPt.y + fromNormal.y * strength,
			c2x: toPt.x + toNormal.x * strength,
			c2y: toPt.y + toNormal.y * strength,
		};
	}

	private getQuadraticControlThroughMid(
		p0: { x: number; y: number },
		p2: { x: number; y: number },
		mid: { x: number; y: number }
	): { x: number; y: number } {
		return {
			x: 2 * mid.x - 0.5 * (p0.x + p2.x),
			y: 2 * mid.y - 0.5 * (p0.y + p2.y),
		};
	}

	private getSideNormal(side: NodeSide): { x: number; y: number } {
		switch (side) {
			case "top":
				return { x: 0, y: -1 };
			case "right":
				return { x: 1, y: 0 };
			case "bottom":
				return { x: 0, y: 1 };
			case "left":
				return { x: -1, y: 0 };
			default:
				return { x: 1, y: 0 };
		}
	}

	private getCubicPoint(
		p0: { x: number; y: number },
		p1: { x: number; y: number },
		p2: { x: number; y: number },
		p3: { x: number; y: number },
		t: number
	): { x: number; y: number } {
		const u = 1 - t;
		return {
			x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
		};
	}

	private getNodeSidePoint(node: AllCanvasNodeData, side: NodeSide, offset = 0.5): { x: number; y: number } {
		const { x, y, width, height } = node;
		const t = Math.max(0, Math.min(1, offset));
		switch (side) {
			case "top": return { x: x + width * t, y };
			case "right": return { x: x + width, y: y + height * t };
			case "bottom": return { x: x + width * t, y: y + height };
			case "left": return { x, y: y + height * t };
			default: return { x: x + width / 2, y: y + height / 2 };
		}
	}

	/** Closest point on node border to (canvasX, canvasY); returns side and offset 0–1 */
	private getPointOnNodeBorder(
		node: AllCanvasNodeData,
		canvasX: number,
		canvasY: number
	): { side: NodeSide; offset: number } {
		const { x, y, width, height } = node;
		const clamp = (v: number) => Math.max(0, Math.min(1, v));
		const oRight = clamp((canvasY - y) / height);
		const oLeft = oRight;
		const oTop = clamp((canvasX - x) / width);
		const oBottom = oTop;
		const pRight = { x: x + width, y: y + height * oRight };
		const pLeft = { x, y: y + height * oLeft };
		const pTop = { x: x + width * oTop, y };
		const pBottom = { x: x + width * oBottom, y: y + height };
		const dRight = Math.hypot(canvasX - pRight.x, canvasY - pRight.y);
		const dLeft = Math.hypot(canvasX - pLeft.x, canvasY - pLeft.y);
		const dTop = Math.hypot(canvasX - pTop.x, canvasY - pTop.y);
		const dBottom = Math.hypot(canvasX - pBottom.x, canvasY - pBottom.y);
		const min = Math.min(dRight, dLeft, dTop, dBottom);
		if (min === dRight) return { side: "right", offset: oRight };
		if (min === dLeft) return { side: "left", offset: oLeft };
		if (min === dTop) return { side: "top", offset: oTop };
		return { side: "bottom", offset: oBottom };
	}

	private clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
		const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
		if (!(viewport instanceof HTMLElement)) {
			return { x: clientX, y: clientY };
		}
		const rect = viewport.getBoundingClientRect();
		return {
			x: (clientX - rect.left) / this.zoom - this.pan.x / this.zoom,
			y: (clientY - rect.top) / this.zoom - this.pan.y / this.zoom,
		};
	}

	private getViewportCenterCanvas(): { x: number; y: number } {
		const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
		if (!(viewport instanceof HTMLElement)) {
			return { x: 240, y: 180 };
		}
		const rect = viewport.getBoundingClientRect();
		return this.clientToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
	}

	private closeEdgeLabelEditor(): void {
		this.edgeLabelEditorEl?.remove();
		this.edgeLabelEditorEl = null;
	}

	private openEdgeLabelEditor(edge: CanvasEdgeData, clientX: number, clientY: number): void {
		this.closeEdgeLabelEditor();
		const editor = document.createElement("div");
		editor.className = "heinibal-context-menu heinibal-edge-menu";
		editor.style.left = `${clientX}px`;
		editor.style.top = `${clientY}px`;

		const input = editor.createEl("input", {
			type: "text",
			placeholder: "Edge note",
		});
		input.value = edge.label ?? "";

		const row = editor.createDiv({ cls: "heinibal-panel-row" });
		const saveBtn = row.createEl("button", { text: "Save" });
		const clearBtn = row.createEl("button", { text: "Clear" });

		const apply = () => {
			edge.label = input.value.trim() || undefined;
			this.renderEdges();
			this.saveCanvasData();
			this.closeEdgeLabelEditor();
		};

		saveBtn.onclick = apply;
		clearBtn.onclick = () => {
			input.value = "";
			apply();
		};
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				apply();
			}
			if (ev.key === "Escape") {
				ev.preventDefault();
				this.closeEdgeLabelEditor();
			}
		});

		document.body.appendChild(editor);
		this.edgeLabelEditorEl = editor;
		input.focus();
		input.select();

		setTimeout(() => {
			document.addEventListener(
				"mousedown",
				(ev) => {
					if (!this.edgeLabelEditorEl) return;
					if (this.edgeLabelEditorEl.contains(ev.target as Node)) return;
					this.closeEdgeLabelEditor();
				},
				{ once: true }
			);
		}, 0);
	}

	private resolveColor(color?: string): string {
		if (!color) return "var(--color-accent)";
		if (color.startsWith("#") || color.startsWith("rgb")) return color;
		return CANVAS_COLORS[color] ?? "var(--color-accent)";
	}

	private isTypingTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		return (
			el.tagName === "INPUT" ||
			el.tagName === "TEXTAREA" ||
			el.isContentEditable
		);
	}

	private clearSelection(): void {
		// if (this.selectedNodeId) {
		// 	this.refreshNodeCardById(this.selectedNodeId);
		// }
		this.selectedNodeId = null;
		this.selectedNodeWrapper?.removeClass("is-selected");
		this.selectedNodeWrapper = null;
	}

	private refreshNodeCardById(nodeId: string): void {
		const node = this.canvasData.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		const wrapper = this.nodesContainer?.querySelector(`.heinibal-node-wrapper[data-node-id="${nodeId}"]`) as HTMLElement | null;
		if (!wrapper) return;
		const nodeEl = wrapper.querySelector(".heinibal-canvas-node") as HTMLElement | null;
		if (!nodeEl) return;
		nodeEl.empty();
		if (node.type === "file") this.renderFileCard(nodeEl, node as CanvasFileData);
		else if (node.type === "text") this.renderTextNode(nodeEl, node);
		else if (node.type === "group") this.renderGroupNode(nodeEl, node as CanvasGroupData);
		else if (node.type === "link") this.renderLinkNode(nodeEl, node);
	}

	private deleteNodeById(nodeId: string): void {
		const before = this.canvasData.nodes.length;
		this.canvasData.nodes = this.canvasData.nodes.filter((n) => n.id !== nodeId);
		if (this.canvasData.nodes.length === before) return;
		this.canvasData.edges = this.canvasData.edges.filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId);
		this.renderCanvas();
		this.saveCanvasData();
	}

	private applyNodeResize(e: MouseEvent): void {
		if (!this.resizeState) return;
		const s = this.resizeState;
		const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
		const rect = viewport instanceof HTMLElement ? viewport.getBoundingClientRect() : null;
		const scale = this.zoom || 1;
		const dx = rect ? (e.clientX - s.startX) / scale : e.clientX - s.startX;
		const dy = rect ? (e.clientY - s.startY) / scale : e.clientY - s.startY;

		let x = s.startNodeX;
		let y = s.startNodeY;
		let width = s.startWidth;
		let height = s.startHeight;

		if (s.dir.includes("e")) width = Math.max(MIN_NODE_WIDTH, s.startWidth + dx);
		if (s.dir.includes("s")) height = Math.max(MIN_NODE_HEIGHT, s.startHeight + dy);
		if (s.dir.includes("w")) {
			const nextWidth = Math.max(MIN_NODE_WIDTH, s.startWidth - dx);
			x = s.startNodeX + (s.startWidth - nextWidth);
			width = nextWidth;
		}
		if (s.dir.includes("n")) {
			const nextHeight = Math.max(MIN_NODE_HEIGHT, s.startHeight - dy);
			y = s.startNodeY + (s.startHeight - nextHeight);
			height = nextHeight;
		}

		s.node.x = x;
		s.node.y = y;
		s.node.width = width;
		s.node.height = height;

		s.wrapper.style.left = `${x}px`;
		s.wrapper.style.top = `${y}px`;
		s.wrapper.style.width = `${width}px`;
		s.wrapper.style.height = `${height}px`;
		s.nodeEl.style.width = `${width}px`;
		s.nodeEl.style.height = `${height}px`;
		this.renderEdges();
	}

	private renderNode(node: AllCanvasNodeData): void {
		const wrapper = this.nodesContainer.createDiv({ cls: "heinibal-node-wrapper" });
		wrapper.dataset.nodeId = node.id ?? "";

		const nodeEl = wrapper.createDiv({ cls: "heinibal-canvas-node" });
		nodeEl.style.left = "0";
		nodeEl.style.top = "0";
		nodeEl.style.width = `${node.width}px`;
		nodeEl.style.height = `${node.height}px`;

		wrapper.style.left = `${node.x}px`;
		wrapper.style.top = `${node.y}px`;
		wrapper.style.width = `${node.width}px`;
		wrapper.style.height = `${node.height}px`;

		const borderColor = this.resolveColor(node.color);
		nodeEl.style.borderLeftColor = borderColor;
		this.applyShape(nodeEl, node.shape);

		if (node.type === "file") {
			this.renderFileCard(nodeEl, node as CanvasFileData);
		} else if (node.type === "text") {
			this.renderTextNode(nodeEl, node);
		} else if (node.type === "group") {
			this.renderGroupNode(nodeEl, node as CanvasGroupData);
		} else if (node.type === "link") {
			this.renderLinkNode(nodeEl, node);
		}

		this.renderResizeHandles(wrapper, nodeEl, node);

		this.registerDomEvent(wrapper, "mouseenter", () => this.showConnectionDots(wrapper, node));
		this.registerDomEvent(wrapper, "mouseleave", () => this.hideConnectionDots(wrapper));

		this.registerDomEvent(nodeEl, "mousedown", (e: MouseEvent) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			this.nodeMouseDownPos = { x: e.clientX, y: e.clientY };
			this.nodeMouseDownId = node.id ?? null;
			this.didDragThisPointer = false;
			this.draggedNodeId = null;
		});

		this.registerDomEvent(document, "mousemove", (e: MouseEvent) => {
			if (this.draggedNodeId === node.id) {
				const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
				if (viewport instanceof HTMLElement) {
					const rect = viewport.getBoundingClientRect();
					node.x = (e.clientX - rect.left) / this.zoom - this.pan.x / this.zoom + this.dragOffset.x;
					node.y = (e.clientY - rect.top) / this.zoom - this.pan.y / this.zoom + this.dragOffset.y;
				} else {
					node.x = e.clientX - this.dragOffset.x;
					node.y = e.clientY - this.dragOffset.y;
				}
				wrapper.style.left = `${node.x}px`;
				wrapper.style.top = `${node.y}px`;
				this.renderEdges();
			} else if (
				this.nodeMouseDownPos &&
				!this.didDragThisPointer &&
				this.draggedNodeId === null &&
				this.nodeMouseDownId === node.id
			) {
				const dx = e.clientX - this.nodeMouseDownPos.x;
				const dy = e.clientY - this.nodeMouseDownPos.y;
				if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
					this.beginNodeDrag(node, this.nodeMouseDownPos.x, this.nodeMouseDownPos.y);
					this.didDragThisPointer = true;
				}
			}
		});

		this.registerDomEvent(document, "mouseup", () => {
			this.nodeMouseDownPos = null;
			this.nodeMouseDownId = null;
		});

		this.registerDomEvent(nodeEl, "mouseup", (e: MouseEvent) => {
			if (e.button !== 0) return;
			if (!this.didDragThisPointer && this.draggedNodeId !== node.id) {
				const moved = this.nodeMouseDownPos
					? Math.hypot(e.clientX - this.nodeMouseDownPos.x, e.clientY - this.nodeMouseDownPos.y) > DRAG_THRESHOLD_PX
					: false;
				if (!moved) {
					if (this.selectedNodeId === node.id) {
						this.hideSubmenu();
						this.clearSelection();
						this.closeDetailLeaf();
					} else {
						this.selectNode(node, nodeEl, wrapper);
					}
				}
			}
		});

		this.registerDomEvent(nodeEl, "contextmenu", (e: MouseEvent) => {
			e.preventDefault();
			this.selectNode(node, nodeEl, wrapper);
		});
	}

	private beginNodeDrag(node: AllCanvasNodeData, pointerClientX: number, pointerClientY: number): void {
		this.draggedNodeId = node.id ?? null;
		const pointerCanvas = this.clientToCanvas(pointerClientX, pointerClientY);
		this.dragOffset = { x: node.x - pointerCanvas.x, y: node.y - pointerCanvas.y };
	}

	private renderResizeHandles(wrapper: HTMLElement, nodeEl: HTMLElement, node: AllCanvasNodeData): void {
		const dirs: Array<"n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"> = [
			"n", "s", "e", "w", "ne", "nw", "se", "sw",
		];
		for (const dir of dirs) {
			const handle = wrapper.createDiv({ cls: `heinibal-resize-handle heinibal-resize-${dir}` });
			this.registerDomEvent(handle, "mousedown", (e: MouseEvent) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				this.resizeState = {
					nodeId: node.id,
					dir,
					startX: e.clientX,
					startY: e.clientY,
					startNodeX: node.x,
					startNodeY: node.y,
					startWidth: node.width,
					startHeight: node.height,
					wrapper,
					nodeEl,
					node,
				};
				this.selectNode(node, nodeEl, wrapper);
			});
		}
	}

	private applyShape(el: HTMLElement, shape?: NodeShape): void {
		el.removeClass("heinibal-shape-rectangle", "heinibal-shape-rounded", "heinibal-shape-pill");
		el.addClass("heinibal-shape-" + (shape ?? "rounded"));
	}

	private showConnectionDots(wrapper: HTMLElement, node: AllCanvasNodeData): void {
		if (this.edgeFrom) return;
		const sides: NodeSide[] = ["top", "right", "bottom", "left"];
		for (const side of sides) {
			const dot = wrapper.createDiv({ cls: "heinibal-conn-dot" });
			dot.dataset.side = side;
			dot.dataset.nodeId = node.id ?? "";
			dot.addClass("heinibal-conn-dot-" + side);

			this.registerDomEvent(dot, "mousedown", (e: MouseEvent) => {
				e.stopPropagation();
				e.preventDefault();
				this.startEdge(node.id ?? "", side, dot);
			});
		}
	}

	private hideConnectionDots(wrapper: HTMLElement): void {
		wrapper.findAll(".heinibal-conn-dot").forEach((el) => el.remove());
	}

	private startEdge(nodeId: string, side: NodeSide, dotEl: HTMLElement): void {
		this.edgeFrom = { nodeId, side, dotEl };
		const stage = this.canvasStageEl;
		if (!stage) return;
		this.tempEdgeContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.tempEdgeContainer.setAttribute("class", "heinibal-temp-edge");
		this.tempEdgeContainer.setAttribute("width", String(CANVAS_SIZE_PX));
		this.tempEdgeContainer.setAttribute("height", String(CANVAS_SIZE_PX));
		this.tempEdgeContainer.setAttribute("overflow", "visible");
		this.tempEdgeContainer.style.pointerEvents = "none";
		this.edgeLineEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
		this.tempEdgeContainer.appendChild(this.edgeLineEl);
		stage.appendChild(this.tempEdgeContainer);
	}

	private updateTempEdge(e: MouseEvent): void {
		if (!this.edgeFrom || !this.edgeLineEl || !this.nodesContainer) return;
		const fromNode = this.canvasData.nodes.find((n) => n.id === this.edgeFrom!.nodeId);
		if (!fromNode) return;
		const fromPt = this.getNodeSidePoint(fromNode, this.edgeFrom.side);
		const toPt = this.clientToCanvas(e.clientX, e.clientY);
		const dx = toPt.x - fromPt.x;
		const dy = toPt.y - fromPt.y;
		const len = Math.hypot(dx, dy) || 1;
		const midX = (fromPt.x + toPt.x) / 2;
		const midY = (fromPt.y + toPt.y) / 2;
		const bend = Math.min(80, len * 0.2);
		const perpX = (-dy / len) * bend;
		const perpY = (dx / len) * bend;
		const ctrlX = midX + perpX;
		const ctrlY = midY + perpY;
		const d = `M ${fromPt.x} ${fromPt.y} Q ${ctrlX} ${ctrlY} ${toPt.x} ${toPt.y}`;
		this.edgeLineEl.setAttribute("d", d);
		this.edgeLineEl.setAttribute("fill", "none");
		this.edgeLineEl.setAttribute("stroke", "var(--color-accent)");
		this.edgeLineEl.setAttribute("stroke-width", "2");
		this.edgeLineEl.setAttribute("stroke-dasharray", "5 4");
	}

	private finishEdge(): void {
		if (!this.edgeFrom) return;
		this.tempEdgeContainer?.remove();
		this.tempEdgeContainer = null;
		this.edgeLineEl = null;
		this.edgeFrom = null;
	}

	private selectNode(node: AllCanvasNodeData, nodeEl: HTMLElement, wrapper: HTMLElement): void {
		this.hideSubmenu();
		this.clearSelection();
		this.selectedNodeId = node.id ?? null;
		this.selectedNodeWrapper = wrapper;
		wrapper.addClass("is-selected");
		this.refreshNodeCardById(node.id);

		if (node.type === "file") {
			const file = this.app.vault.getAbstractFileByPath((node as CanvasFileData).file);
			if (file instanceof TFile) {
				this.openFileInRightPane(file);
			}
		}

		this.showSubmenuBelowCard(node, nodeEl, wrapper);
	}

	private showSubmenuBelowCard(node: AllCanvasNodeData, nodeEl: HTMLElement, wrapper: HTMLElement): void {
		this.hideSubmenu();
		const panel = wrapper.createDiv({ cls: "heinibal-card-submenu" });
		this.addNodeContentEditor(panel, node, nodeEl);

		const presetColors = ["1", "2", "3", "4", "5", "6"];
		const colorRow = panel.createDiv({ cls: "heinibal-panel-row" });
		colorRow.createSpan({ text: "Color:", cls: "heinibal-panel-label" });
		for (const c of presetColors) {
			const btn = colorRow.createEl("button", { cls: "heinibal-color-btn" });
			btn.style.backgroundColor = CANVAS_COLORS[c] ?? c;
			btn.onclick = () => this.setNodeColor(node, nodeEl, CANVAS_COLORS[c] ?? c);
		}
		const customColor = colorRow.createEl("input", { attr: { type: "color" } });
		customColor.className = "heinibal-color-custom";
		customColor.value = this.nodeColorToHex(node);
		customColor.oninput = () => this.setNodeColor(node, nodeEl, customColor.value);

		const shapeRow = panel.createDiv({ cls: "heinibal-panel-row" });
		shapeRow.createSpan({ text: "Shape:", cls: "heinibal-panel-label" });
		const shapes: NodeShape[] = ["rectangle", "rounded", "pill"];
		for (const s of shapes) {
			const btn = shapeRow.createEl("button", { text: s });
			btn.onclick = () => this.setNodeShape(node, nodeEl, s);
		}

		if (node.type === "file") {
			const file = this.app.vault.getAbstractFileByPath((node as CanvasFileData).file);
			if (file instanceof TFile) {
				const openBtn = panel.createEl("button", { text: "Open in right", title: "Already opened; click to focus" });
				openBtn.onclick = () => this.openFileInRightPane(file);
			}
		}

		const deleteBtn = panel.createEl("button", { text: "Delete", cls: "heinibal-panel-delete" });
		deleteBtn.onclick = () => {
			this.hideSubmenu();
			this.deleteNodeById(node.id);
		};
		this.selectedSubmenuEl = panel;
	}

	private addNodeContentEditor(panel: HTMLElement, node: AllCanvasNodeData, nodeEl: HTMLElement): void {
		const row = panel.createDiv({ cls: "heinibal-panel-row heinibal-panel-content-row" });
		row.createSpan({ text: "Content:", cls: "heinibal-panel-label" });

		if (node.type === "file") {
			const input = row.createEl("input", { type: "text", placeholder: "Card title override" });
			input.value = String((node as CanvasFileData & { title?: string }).title ?? "");
			input.oninput = () => {
				(node as CanvasFileData & { title?: string }).title = input.value.trim() || undefined;
				const titleEl = nodeEl.querySelector(".heinibal-file-title");
				if (titleEl) titleEl.textContent = this.getFileNodeDisplayTitle(node as CanvasFileData);
				this.saveCanvasData();
			};
			return;
		}

		if (node.type === "text") {
			const input = row.createEl("textarea", { cls: "heinibal-panel-textarea" });
			input.value = String((node as CanvasTextData).text ?? "");
			input.oninput = () => {
				(node as CanvasTextData).text = input.value;
				const textEl = nodeEl.querySelector(".heinibal-text-content");
				if (textEl) textEl.textContent = input.value;
				this.saveCanvasData();
			};
			return;
		}

		if (node.type === "group") {
			const input = row.createEl("input", { type: "text", placeholder: "Group name" });
			input.value = (node as CanvasGroupData).label ?? "";
			input.oninput = () => {
				(node as CanvasGroupData).label = input.value.trim() || "Group";
				const labelEl = nodeEl.querySelector(".heinibal-node-label");
				if (labelEl) labelEl.textContent = (node as CanvasGroupData).label ?? "Group";
				this.saveCanvasData();
			};
			return;
		}

		if (node.type === "link") {
			const input = row.createEl("input", { type: "text", placeholder: "URL" });
			input.value = String((node as { url?: string }).url ?? "");
			input.oninput = () => {
				(node as { url?: string }).url = input.value.trim();
				const labelEl = nodeEl.querySelector(".heinibal-node-label");
				if (labelEl) labelEl.textContent = (node as { url?: string }).url ?? "";
				this.saveCanvasData();
			};
		}
	}

	private nodeColorToHex(node: AllCanvasNodeData): string {
		const c = node.color;
		if (c?.startsWith("#")) return c;
		const preset = c ? CANVAS_COLORS[c] : null;
		if (preset && preset.startsWith("var(")) {
			const varName = preset.replace(/^var\(|\)$/g, "").trim();
			const style = getComputedStyle(document.body);
			const val = style.getPropertyValue(varName).trim();
			if (val) return val;
		}
		return "#7c3aed";
	}

	private setNodeColor(node: AllCanvasNodeData, nodeEl: HTMLElement, hexOrVar: string): void {
		node.color = hexOrVar;
		nodeEl.style.borderLeftColor = hexOrVar;
		this.saveCanvasData();
	}

	private setNodeShape(node: AllCanvasNodeData, nodeEl: HTMLElement, shape: NodeShape): void {
		node.shape = shape;
		this.applyShape(nodeEl, shape);
		this.saveCanvasData();
	}

	private hideSubmenu(): void {
		this.contentEl.findAll(".heinibal-card-submenu").forEach((el) => el.remove());
		this.selectedSubmenuEl = null;
	}

	private renderFileCard(container: HTMLElement, node: CanvasFileData): void {
		container.addClass("heinibal-file-card");

		const file = this.app.vault.getAbstractFileByPath(node.file);
		if (!(file instanceof TFile)) {
			container.createDiv({ text: "File not found", cls: "heinibal-node-error" });
			return;
		}

		const title = this.getFileNodeDisplayTitle(node, file);
		const modDate = file.stat
			? new Date(file.stat.mtime).toLocaleDateString(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
				})
			: "";

		const header = container.createDiv({ cls: "heinibal-node-header" });
		header.createEl("span", { text: title, cls: "heinibal-file-title" });

		const preview = container.createDiv({ cls: "heinibal-file-preview", text: "Loading preview..." });
		void this.populateFilePreview(preview, file.path);

		const meta = container.createDiv({ cls: "heinibal-file-meta" });
		if (modDate) {
			meta.createEl("span", { text: modDate, cls: "heinibal-mod-date" });
		}
	}

	private async populateFilePreview(previewEl: HTMLElement, filePath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			previewEl.setText("No preview available");
			return;
		}
		try {
			const raw = await this.app.vault.cachedRead(file);
			const lines = raw
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("#") && line !== "---" && !line.startsWith("```"));
			const text = lines.join(" ").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\s+/g, " ").trim();
			const preview = text.length > 160 ? `${text.slice(0, 160)}...` : text;
			previewEl.setText(preview || "No preview available");
		} catch {
			previewEl.setText("No preview available");
		}
	}

	private getFileNodeDisplayTitle(node: CanvasFileData, resolvedFile?: TFile): string {
		const override = (node as CanvasFileData & { title?: string }).title;
		if (typeof override === "string" && override.trim().length > 0) return override.trim();
		const file = resolvedFile ?? this.app.vault.getAbstractFileByPath(node.file);
		if (!(file instanceof TFile)) return "File not found";
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.title ?? file.basename;
	}

	private getFileTags(file: TFile, cache: CachedMetadata | null): string[] {
		const tags: string[] = [];
		if (cache?.tags) {
			for (const t of cache.tags) {
				if (t.tag && !tags.includes(t.tag)) tags.push(t.tag);
			}
		}
		const fmTags = parseFrontMatterTags(cache?.frontmatter);
		if (fmTags) {
			for (const t of fmTags) {
				const tag = t.startsWith("#") ? t : `#${t}`;
				if (!tags.includes(tag)) tags.push(tag);
			}
		}
		return tags.slice(0, 5);
	}

	private renderTextNode(container: HTMLElement, node: AllCanvasNodeData): void {
		container.addClass("heinibal-text-node");
		if ("text" in node) {
			container.createDiv({ cls: "heinibal-node-header" }).createEl("span", { text: "Text", cls: "heinibal-node-label" });
			container.createDiv({ text: (node as { text: string }).text, cls: "heinibal-text-content" });
		}
	}

	private renderGroupNode(container: HTMLElement, node: CanvasGroupData): void {
		container.addClass("heinibal-group-node");
		container.createDiv({ cls: "heinibal-node-header" }).createEl("span", { text: node.label || "Group", cls: "heinibal-node-label" });
	}

	private renderLinkNode(container: HTMLElement, node: AllCanvasNodeData): void {
		container.addClass("heinibal-link-node");
		if ("url" in node) {
			container.createDiv({ cls: "heinibal-node-header" }).createEl("span", { text: (node as { url: string }).url, cls: "heinibal-node-label" });
		}
	}

	private async openFileInRightPane(file: TFile): Promise<void> {
		let leaf = this.detailLeaf;
		let stillThere = false;
		if (leaf) {
			this.app.workspace.iterateAllLeaves((l) => {
				if (l === leaf) stillThere = true;
			});
		}
		if (!stillThere || !leaf) {
			leaf = this.app.workspace.getLeaf("split", "vertical");
			this.detailLeaf = leaf;
		}
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private closeDetailLeaf(): void {
		if (!this.detailLeaf) return;
		const selectedId = this.selectedNodeId;
		let stillThere = false;
		this.app.workspace.iterateAllLeaves((l) => {
			if (l === this.detailLeaf) stillThere = true;
		});
		if (stillThere) {
			this.detailLeaf.detach();
		}
		this.detailLeaf = null;
		if (selectedId) this.refreshNodeCardById(selectedId);
	}

	private showAddFilesModal(): void {
		const files = this.app.vault.getMarkdownFiles();
		const data = this.canvasData;
		const existingPaths = new Set(
			(data.nodes as CanvasFileData[]).filter((n) => n.type === "file").map((n) => n.file)
		);

		const modal = document.createElement("div");
		modal.className = "heinibal-add-files-modal";
		modal.innerHTML = '<div class="heinibal-modal-content"><h3>Add files to canvas</h3><div class="heinibal-file-list"></div><button class="heinibal-modal-close">Close</button></div>';
		const list = modal.querySelector(".heinibal-file-list") as HTMLElement;

		for (const file of files) {
			if (existingPaths.has(file.path)) continue;
			const item = list.createEl("div", { cls: "heinibal-file-list-item" });
			item.textContent = file.path;
			item.onclick = () => {
				this.addFileToCanvas(file);
				existingPaths.add(file.path);
				item.remove();
			};
		}

		modal.querySelector(".heinibal-modal-close")?.addEventListener("click", () => modal.remove());
		modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
		document.body.appendChild(modal);
	}

	private addFileToCanvas(file: TFile, position?: { x: number; y: number }): void {
		const data = this.canvasData;
		const fallback = this.getViewportCenterCanvas();
		const x = position?.x ?? (fallback.x + (Math.random() - 0.5) * 120);
		const y = position?.y ?? (fallback.y + (Math.random() - 0.5) * 120);
		const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const node: CanvasFileData = {
			id,
			type: "file",
			file: file.path,
			x,
			y,
			width: 220,
			height: 100,
		};
		data.nodes.push(node);
		this.renderNode(node);
		this.saveCanvasData();
	}

	private addGroup(): void {
		const data = this.canvasData;
		const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const node: CanvasGroupData = {
			id,
			type: "group",
			label: "Group",
			x: 100 + Math.random() * 200,
			y: 100 + Math.random() * 200,
			width: 200,
			height: 120,
		};
		data.nodes.push(node);
		this.renderNode(node);
		this.saveCanvasData();
	}
}

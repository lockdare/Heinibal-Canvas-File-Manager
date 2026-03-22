import {
	App,
	FileView,
	WorkspaceLeaf,
	TFile,
	Notice,
} from "obsidian";
import type {
	CanvasData,
	CanvasFileData,
	CanvasGroupData,
	CanvasEdgeData,
	AllCanvasNodeData,
	NodeShape,
	NodeSide,
	EdgeStyle,
} from "../types";
export const FILE_CARD_CANVAS_VIEW_TYPE = "file-card-canvas";
export const HCANVAS_EXT = "hcanvas";

const DRAG_THRESHOLD_PX = 5;
const CANVAS_SIZE_PX = 120000;
const DEFAULT_VIEW_STATE = { panX: 0, panY: 0, zoom: 1 };
const MAX_ABS_PAN = CANVAS_SIZE_PX * 2;
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
	private nodeWrappers = new Map<string, HTMLElement>();
	private draggedNodeIds = new Set<string>();
	private dragStartPointerCanvas: { x: number; y: number } | null = null;
	private dragNodeStartPositions = new Map<string, { x: number; y: number }>();
	private zoom = 1;
	private pan = { x: 0, y: 0 };
	private isPanning = false;
	private panStart = { x: 0, y: 0 };
	private isMarqueeSelecting = false;
	private marqueeStartClient: { x: number; y: number } | null = null;
	private marqueeCurrentClient: { x: number; y: number } | null = null;
	private marqueeStartCanvas: { x: number; y: number } | null = null;
	private marqueeCurrentCanvas: { x: number; y: number } | null = null;
	private marqueeEl: HTMLElement | null = null;
	private nodeMouseDownPos: { x: number; y: number } | null = null;
	private nodeMouseDownId: string | null = null;
	private didDragThisPointer = false;
	private selectedNodeId: string | null = null;
	private selectedNodeIds = new Set<string>();
	private selectedSubmenuEl: HTMLElement | null = null;
	private edgeFrom: { nodeId: string; side: NodeSide; dotEl: HTMLElement } | null = null;
	private edgeLineEl: SVGPathElement | null = null;
	private tempEdgeContainer: SVGElement | null = null;
	private draggedEdgeControlId: string | null = null;
	private draggedEdgeControlPointerOffset = { x: 0, y: 0 };
	private isRenameWatcherBound = false;
	private edgeLabelEditorEl: HTMLElement | null = null;
	private viewStateSaveTimer: number | null = null;
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
		this.closeEdgeLabelEditor();
		this.closeDetailLeaf();
		if (this.viewStateSaveTimer !== null) {
			window.clearTimeout(this.viewStateSaveTimer);
			this.viewStateSaveTimer = null;
		}
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
				if (node.type === "file" && node.file === oldPath) {
					node.file = file.path;
					changed = true;
				}
			}
			if (!changed) return;
			this.renderCanvas();
			void this.saveCanvasData();
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
			const viewState = parsed.viewState as
				| { panX?: number; panY?: number; zoom?: number }
				| undefined;
			if (viewState) {
				const nextZoom = Number(viewState.zoom);
				const nextPanX = Number(viewState.panX);
				const nextPanY = Number(viewState.panY);
				if (Number.isFinite(nextZoom)) this.zoom = Math.max(0.2, Math.min(4, nextZoom));
				if (Number.isFinite(nextPanX)) this.pan.x = nextPanX;
				if (Number.isFinite(nextPanY)) this.pan.y = nextPanY;
			}
		} catch {
			this.canvasData = { ...DEFAULT_CANVAS_DATA };
		}
	}

	private async saveCanvasData(): Promise<void> {
		if (!this.file) return;
		await this.app.vault.modify(this.file, JSON.stringify(this.canvasData, null, 2));
	}

	private renderCanvas(): void {
		this.closeEdgeLabelEditor();
		this.contentEl.empty();
		this.contentEl.addClass("heinibal-file-card-canvas-container");
		this.contentEl.style.setProperty("--heinibal-canvas-size", `${CANVAS_SIZE_PX}px`);

		const toolbar = this.contentEl.createDiv({ cls: "heinibal-canvas-toolbar" });
		toolbar.createEl("button", { text: "Add files" }).onclick = () => this.showAddFilesModal();
		toolbar.createEl("button", { text: "Add group" }).onclick = () => this.addGroup();
		toolbar.createEl("button", { text: "Cards" }).onclick = () => this.showCanvasNodeListModal();
		toolbar.createEl("button", { text: "Focus cards" }).onclick = () => this.focusCardsInView();
		toolbar.createEl("button", { text: "Reset view" }).onclick = () => this.resetView();

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
		this.nodeWrappers.clear();

		this.renderEdges();
		for (const node of this.canvasData.nodes) {
			this.renderNode(node);
		}

		this.registerDomEvent(viewport, "wheel", (e: WheelEvent) => {
			e.preventDefault();
			const viewportRect = viewport.getBoundingClientRect();
			const insideViewport = (
				e.clientX >= viewportRect.left
				&& e.clientX <= viewportRect.right
				&& e.clientY >= viewportRect.top
				&& e.clientY <= viewportRect.bottom
			);
			if (!insideViewport) return;

			if (!Number.isFinite(this.zoom) || this.zoom <= 0) {
				this.zoom = DEFAULT_VIEW_STATE.zoom;
			}
			this.pan = this.sanitizePan(this.pan);
			const before = this.clientToCanvas(e.clientX, e.clientY);
			const currentZoom = this.zoom;
			const nextZoom = Math.max(0.2, Math.min(4, currentZoom - e.deltaY * 0.001));
			this.zoom = nextZoom;
			this.pan.x = e.clientX - viewportRect.left - before.x * nextZoom;
			this.pan.y = e.clientY - viewportRect.top - before.y * nextZoom;
			this.pan = this.sanitizePan(this.pan);
			this.updateViewportTransform();
			this.scheduleViewStateSave();
		});

		this.registerDomEvent(viewport, "mousedown", (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			const inNode = target?.closest(".heinibal-node-wrapper");
			const inMenu = target?.closest(".heinibal-card-submenu") || target?.closest(".heinibal-context-menu");
			const inToolbar = target?.closest(".heinibal-canvas-toolbar");
			const inEdge = target?.closest(".heinibal-canvas-edges");
			if (e.button === 1 && !inMenu && !inToolbar) {
				e.preventDefault();
				if (!Number.isFinite(this.pan.x) || !Number.isFinite(this.pan.y)) {
					this.pan.x = DEFAULT_VIEW_STATE.panX;
					this.pan.y = DEFAULT_VIEW_STATE.panY;
				}
				this.isPanning = true;
				this.panStart = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
				return;
			}
			if (e.button === 0 && !inNode && !inMenu && !inToolbar && !inEdge) {
				this.startMarqueeSelection(e, viewport);
			}
		});
		this.registerDomEvent(viewport, "dblclick", (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			const inNode = target?.closest(".heinibal-node-wrapper");
			const inMenu = target?.closest(".heinibal-card-submenu") || target?.closest(".heinibal-context-menu");
			const inToolbar = target?.closest(".heinibal-canvas-toolbar");
			const inEdge = target?.closest(".heinibal-canvas-edges");
			if (inNode || inMenu || inToolbar || inEdge) return;
			const pos = this.clientToCanvas(e.clientX, e.clientY);
			void this.createNewFileCardAt(pos.x, pos.y);
		});
		this.registerDomEvent(viewport, "auxclick", (e: MouseEvent) => {
			if (e.button === 1) e.preventDefault();
		});

		this.registerDomEvent(this.contentEl, "mousedown", (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			const inNode = target.closest(".heinibal-node-wrapper");
			const inMenu = target.closest(".heinibal-card-submenu") || target.closest(".heinibal-context-menu");
			if (!inNode && !inMenu) return;
		});

		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "0") {
				e.preventDefault();
				this.resetView();
				return;
			}
			if (e.key !== "Delete" && e.key !== "Backspace") return;
			if (this.selectedNodeIds.size === 0) return;
			if (this.isTypingTarget(e.target)) return;
			e.preventDefault();
			const selectedIds = [...this.selectedNodeIds];
			for (const nodeId of selectedIds) {
				this.deleteNodeById(nodeId, false);
			}
			this.renderEdges();
			void this.saveCanvasData();
		});

		this.registerDomEvent(document, "mousemove", (e: MouseEvent) => {
			if (this.resizeState) {
				this.applyNodeResize(e);
				return;
			}
			if (this.isDraggingNodes()) {
				this.applyNodeDrag(e);
				return;
			}
			if (this.isMarqueeSelecting) {
				this.updateMarqueeSelection(e, viewport);
				return;
			}
			if (this.isPanning) {
				this.pan = this.sanitizePan({
					x: e.clientX - this.panStart.x,
					y: e.clientY - this.panStart.y,
				});
				this.updateViewportTransform();
			}
			if (
				this.nodeMouseDownPos &&
				!this.didDragThisPointer &&
				this.draggedNodeIds.size === 0 &&
				this.nodeMouseDownId
			) {
				if ((e.buttons & 1) === 0) {
					this.nodeMouseDownPos = null;
					this.nodeMouseDownId = null;
					return;
				}
				const dx = e.clientX - this.nodeMouseDownPos.x;
				const dy = e.clientY - this.nodeMouseDownPos.y;
				if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
					const node = this.canvasData.nodes.find((n) => n.id === this.nodeMouseDownId);
					if (node) {
						this.beginNodeDrag(node, this.nodeMouseDownPos.x, this.nodeMouseDownPos.y);
						this.didDragThisPointer = true;
					}
				}
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
			const hadNodeDrag = this.isDraggingNodes();
			const hadPanning = this.isPanning;
			if (this.resizeState) {
				this.resizeState = null;
				void this.saveCanvasData();
			}
			if (this.isMarqueeSelecting) {
				this.finishMarqueeSelection();
			}
			if (this.edgeFrom) {
					const wrapper = document.elementFromPoint(e.clientX, e.clientY)?.closest(".heinibal-node-wrapper");
					const toNodeId = wrapper?.getAttribute("data-node-id") ?? null;
						if (toNodeId && toNodeId !== this.edgeFrom.nodeId) {
							const toNode = this.canvasData.nodes.find((n) => n.id === toNodeId);
							const fromNode = this.canvasData.nodes.find((n) => n.id === this.edgeFrom!.nodeId);
							if (toNode && fromNode) {
								const fromPt = this.getNodeSidePoint(fromNode, this.edgeFrom.side, 0.5);
								const dropPos = this.clientToCanvas(e.clientX, e.clientY);
								const { side: toSide, offset: toOffset } = this.getLineIntersectionOnNodeBorder(
									toNode,
									fromPt.x,
									fromPt.y,
									dropPos.x,
									dropPos.y
								);
								this.canvasData.edges.push({
									id: "edge-" + Date.now(),
									fromNode: this.edgeFrom.nodeId,
									fromSide: this.edgeFrom.side,
									fromOffset: 0.5,
									toNode: toNodeId,
									toSide,
									toOffset,
									fromEnd: "none",
									toEnd: "arrow",
									edgeStyle: "curve",
								});
								this.renderEdges();
								void this.saveCanvasData();
							}
					}
					this.finishEdge();
				}
				if (this.draggedEdgeControlId) {
					this.draggedEdgeControlId = null;
					void this.saveCanvasData();
				}
			this.isPanning = false;
			this.draggedNodeIds.clear();
			this.dragStartPointerCanvas = null;
			this.dragNodeStartPositions.clear();
			this.nodeMouseDownPos = null;
			this.nodeMouseDownId = null;
			if (hadNodeDrag) {
				void this.saveCanvasData();
			}
			if (hadPanning) {
				this.scheduleViewStateSave(0);
			}
		});

		this.setupDropZone(this.contentEl);

		this.updateViewportTransform();
	}

	private updateViewportTransform(): void {
		if (!Number.isFinite(this.zoom)) this.zoom = DEFAULT_VIEW_STATE.zoom;
		this.zoom = Math.max(0.2, Math.min(4, this.zoom));
		this.pan = this.sanitizePan(this.pan);
		if (this.canvasStageEl instanceof HTMLElement) {
			this.canvasStageEl.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
		}
		this.canvasData.viewState = {
			panX: this.pan.x,
			panY: this.pan.y,
			zoom: this.zoom,
		};
	}

	private scheduleViewStateSave(delay = 160): void {
		if (this.viewStateSaveTimer !== null) {
			window.clearTimeout(this.viewStateSaveTimer);
			this.viewStateSaveTimer = null;
		}
		this.viewStateSaveTimer = window.setTimeout(() => {
			this.viewStateSaveTimer = null;
			void this.saveCanvasData();
		}, delay);
	}

	private sanitizePan(pan: { x: number; y: number }): { x: number; y: number } {
		const x = Number.isFinite(pan.x) ? pan.x : DEFAULT_VIEW_STATE.panX;
		const y = Number.isFinite(pan.y) ? pan.y : DEFAULT_VIEW_STATE.panY;
		return {
			x: Math.max(-MAX_ABS_PAN, Math.min(MAX_ABS_PAN, x)),
			y: Math.max(-MAX_ABS_PAN, Math.min(MAX_ABS_PAN, y)),
		};
	}

	private resetView(): void {
		this.zoom = DEFAULT_VIEW_STATE.zoom;
		this.pan = { x: DEFAULT_VIEW_STATE.panX, y: DEFAULT_VIEW_STATE.panY };
		this.updateViewportTransform();
		this.scheduleViewStateSave(0);
	}

	private focusCardsInView(): void {
		const nodes = this.canvasData.nodes;
		if (nodes.length === 0) {
			this.resetView();
			return;
		}
		const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
		if (!(viewport instanceof HTMLElement)) {
			this.resetView();
			return;
		}

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const node of nodes) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x + node.width);
			maxY = Math.max(maxY, node.y + node.height);
		}

		const rect = viewport.getBoundingClientRect();
		const padding = 120;
		const contentWidth = Math.max(1, maxX - minX);
		const contentHeight = Math.max(1, maxY - minY);
		const fitZoomX = rect.width / (contentWidth + padding * 2);
		const fitZoomY = rect.height / (contentHeight + padding * 2);
		const fitZoom = Math.min(fitZoomX, fitZoomY);
		this.zoom = Math.max(0.2, Math.min(4, fitZoom));

		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		this.pan.x = rect.width / 2 - cx * this.zoom;
		this.pan.y = rect.height / 2 - cy * this.zoom;
		this.updateViewportTransform();
		this.scheduleViewStateSave(0);
	}

	private async createNewCanvasFile(): Promise<void> {
		const folder = (this.plugin.settings.defaultCanvasFolder ?? "").trim() || null;
		const path = this.getNextAvailableFilePath(folder, "Untitled Canvas", FileCardCanvasView.HCANVAS_EXT);
		const file = await this.app.vault.create(path, JSON.stringify(DEFAULT_CANVAS_DATA, null, 2));
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.openFile(file);
	}

	private getCanvasFolderPath(): string | null {
		const canvasFolder = this.file?.parent?.path?.trim();
		if (canvasFolder) return canvasFolder;
		const fallback = (this.plugin.settings.defaultCanvasFolder ?? "").trim();
		return fallback || null;
	}

	private async createNewFileCardAt(x: number, y: number): Promise<void> {
		const folder = this.getCanvasFolderPath();
		const path = this.getNextAvailableFilePath(folder, "Untitled", "md");
		const file = await this.app.vault.create(path, "");
		this.addFileToCanvas(file, { x, y });
		void this.saveCanvasData();
	}

	private getNextAvailableFilePath(folder: string | null, base: string, ext: string): string {
		const normalizedFolder = folder?.trim() || "";
		const inFolder = this.app.vault.getFiles().filter((f) => {
			const parentPath = f.parent?.path ?? "";
			return parentPath === normalizedFolder;
		});
		const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`^${escapedBase}(?:\\s*(\\d+))?\\.${escapedExt}$`, "i");
		const used = new Set<number>();
		for (const file of inFolder) {
			const match = file.name.match(pattern);
			if (!match) continue;
			if (!match[1]) {
				used.add(0);
				continue;
			}
			const index = Number(match[1]);
			if (Number.isFinite(index) && index >= 0) used.add(index);
		}
		let next = 0;
		while (used.has(next)) next++;

		for (let attempt = 0; attempt < 10000; attempt++) {
			const candidateName = next === 0 ? `${base}.${ext}` : `${base} ${next}.${ext}`;
			const candidatePath = normalizedFolder ? `${normalizedFolder}/${candidateName}` : candidateName;
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) return candidatePath;
			next++;
		}
		const fallbackName = `${base}-${Date.now()}.${ext}`;
		return normalizedFolder ? `${normalizedFolder}/${fallbackName}` : fallbackName;
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
			if (added.size > 0) {
				this.autoLinkImportedFiles([...added]);
				void this.saveCanvasData();
			}
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
											} catch {
												// Ignore non-JSON drag string payload.
											}
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
		} catch {
			// Ignore malformed drag payloads.
		}

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
			} catch {
				// Ignore invalid Obsidian URL payload.
			}
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
			const style = edge.edgeStyle ?? "curve";
			let d = "";
			let labelPt = { x: 0, y: 0 };
			let handlePt = { x: 0, y: 0 };
			let showHandle = false;

			if (style === "straight") {
				d = `M ${fromPt.x} ${fromPt.y} L ${toPt.x} ${toPt.y}`;
				labelPt = { x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2 };
				handlePt = labelPt;
				} else if (style === "elbow") {
					const elbow = this.getElbowPath(
						edge,
						fromPt,
						toPt,
						edge.fromSide ?? "right",
						edge.toSide ?? "left"
					);
					d = elbow.d;
					labelPt = elbow.label;
					handlePt = elbow.handle;
					showHandle = true;
				} else {
				const curve = this.getEdgeCurve(edge, fromPt, toPt);
				if (curve.type === "manual") {
					d = `M ${fromPt.x} ${fromPt.y} Q ${curve.cx} ${curve.cy} ${toPt.x} ${toPt.y}`;
					labelPt = { x: curve.midX, y: curve.midY };
					handlePt = { x: curve.midX, y: curve.midY };
				} else {
					d = `M ${fromPt.x} ${fromPt.y} C ${curve.c1x} ${curve.c1y} ${curve.c2x} ${curve.c2y} ${toPt.x} ${toPt.y}`;
					labelPt = this.getCubicPoint(
						fromPt,
						{ x: curve.c1x, y: curve.c1y },
						{ x: curve.c2x, y: curve.c2y },
						toPt,
						0.5
					);
					handlePt = labelPt;
				}
				showHandle = true;
			}

			const g = document.createElementNS(svgNS, "g");
			g.dataset.edgeId = edge.id;

			const hitPath = document.createElementNS(svgNS, "path");
			hitPath.setAttribute("d", d);
			hitPath.setAttribute("fill", "none");
			hitPath.setAttribute("stroke", "transparent");
			hitPath.setAttribute("stroke-width", "16");
			hitPath.setAttribute("class", "heinibal-edge-path");
			hitPath.setAttribute("pointer-events", "stroke");
			g.appendChild(hitPath);

			const path = document.createElementNS(svgNS, "path");
			const color = this.resolveColor(edge.color);
			path.setAttribute("d", d);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", color);
			path.setAttribute("stroke-width", "2");
			if ((edge.fromEnd ?? "none") === "arrow") {
				path.setAttribute("marker-start", "url(#arrowhead-start)");
			}
			if ((edge.toEnd ?? "arrow") === "arrow") {
				path.setAttribute("marker-end", "url(#arrowhead-end)");
			}
			path.setAttribute("class", "heinibal-edge-path-visible");
			path.setAttribute("pointer-events", "none");
			g.appendChild(path);

			const text = document.createElementNS(svgNS, "text");
			text.setAttribute("x", String(labelPt.x));
			text.setAttribute("y", String(labelPt.y));
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("dominant-baseline", "middle");
			text.setAttribute("class", "heinibal-edge-label");
			text.setAttribute("font-size", "12");
			text.textContent = edge.label ?? "";
			text.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.openEdgeLabelEditor(edge, ev.clientX, ev.clientY);
			});
			g.appendChild(text);

			if (showHandle) {
				const handle = document.createElementNS(svgNS, "circle");
				handle.setAttribute("cx", String(handlePt.x));
				handle.setAttribute("cy", String(handlePt.y));
				handle.setAttribute("r", "8");
				handle.setAttribute("class", "heinibal-edge-handle");
				handle.setAttribute("pointer-events", "all");
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
			}

			hitPath.addEventListener("contextmenu", (ev: MouseEvent) => {
				ev.preventDefault();
				this.canvasData.edges = this.canvasData.edges.filter((it) => it.id !== edge.id);
				this.renderEdges();
				void this.saveCanvasData();
			});
			hitPath.addEventListener("click", (ev: MouseEvent) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.openEdgeLabelEditor(edge, ev.clientX, ev.clientY);
			});
			this.edgesContainer.appendChild(g);
		}

		const defs = document.createElementNS(svgNS, "defs");
		const markerEnd = document.createElementNS(svgNS, "marker");
		markerEnd.setAttribute("id", "arrowhead-end");
		markerEnd.setAttribute("markerWidth", "10");
		markerEnd.setAttribute("markerHeight", "7");
		markerEnd.setAttribute("refX", "9");
		markerEnd.setAttribute("refY", "3.5");
		markerEnd.setAttribute("orient", "auto");
		const polyEnd = document.createElementNS(svgNS, "polygon");
		polyEnd.setAttribute("points", "0 0, 10 3.5, 0 7");
		polyEnd.setAttribute("fill", "context-stroke");
		markerEnd.appendChild(polyEnd);

		const markerStart = document.createElementNS(svgNS, "marker");
		markerStart.setAttribute("id", "arrowhead-start");
		markerStart.setAttribute("markerWidth", "10");
		markerStart.setAttribute("markerHeight", "7");
		markerStart.setAttribute("refX", "1");
		markerStart.setAttribute("refY", "3.5");
		markerStart.setAttribute("orient", "auto-start-reverse");
		const polyStart = document.createElementNS(svgNS, "polygon");
		polyStart.setAttribute("points", "0 0, 10 3.5, 0 7");
		polyStart.setAttribute("fill", "context-stroke");
		markerStart.appendChild(polyStart);

		defs.appendChild(markerEnd);
		defs.appendChild(markerStart);
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

	/** Closest point on node border to (canvasX, canvasY); returns side and offset 0鈥? */
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

	private getLineIntersectionOnNodeBorder(
		node: AllCanvasNodeData,
		fromX: number,
		fromY: number,
		toX: number,
		toY: number
	): { side: NodeSide; offset: number } {
		const { x, y, width, height } = node;
		const dx = toX - fromX;
		const dy = toY - fromY;
		const eps = 1e-6;
		const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
		const candidates: Array<{ t: number; side: NodeSide; offset: number }> = [];
		const addCandidate = (t: number, side: NodeSide, offset: number): void => {
			if (!Number.isFinite(t)) return;
			if (t < -eps || t > 1 + eps) return;
			candidates.push({ t, side, offset: clamp01(offset) });
		};

		if (Math.abs(dx) > eps) {
			const tLeft = (x - fromX) / dx;
			const yLeft = fromY + tLeft * dy;
			if (yLeft >= y - eps && yLeft <= y + height + eps) {
				addCandidate(tLeft, "left", (yLeft - y) / height);
			}
			const tRight = (x + width - fromX) / dx;
			const yRight = fromY + tRight * dy;
			if (yRight >= y - eps && yRight <= y + height + eps) {
				addCandidate(tRight, "right", (yRight - y) / height);
			}
		}

		if (Math.abs(dy) > eps) {
			const tTop = (y - fromY) / dy;
			const xTop = fromX + tTop * dx;
			if (xTop >= x - eps && xTop <= x + width + eps) {
				addCandidate(tTop, "top", (xTop - x) / width);
			}
			const tBottom = (y + height - fromY) / dy;
			const xBottom = fromX + tBottom * dx;
			if (xBottom >= x - eps && xBottom <= x + width + eps) {
				addCandidate(tBottom, "bottom", (xBottom - x) / width);
			}
		}

		if (candidates.length === 0) {
			return this.getPointOnNodeBorder(node, toX, toY);
		}

		let chosen = candidates[0]!;
		for (const candidate of candidates) {
			if (candidate.t > chosen.t) chosen = candidate;
		}
		return { side: chosen.side, offset: chosen.offset };
	}

	private clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
		const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
		if (!(viewport instanceof HTMLElement)) {
			return { x: clientX, y: clientY };
		}
		const rect = viewport.getBoundingClientRect();
		const safeZoom = Number.isFinite(this.zoom) && this.zoom > 0 ? this.zoom : DEFAULT_VIEW_STATE.zoom;
		const safePan = this.sanitizePan(this.pan);
		return {
			x: (clientX - rect.left) / safeZoom - safePan.x / safeZoom,
			y: (clientY - rect.top) / safeZoom - safePan.y / safeZoom,
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

	private centerViewOnCanvasPoint(x: number, y: number): void {
		const viewport = this.contentEl.querySelector(".heinibal-canvas-viewport");
		if (!(viewport instanceof HTMLElement)) return;
		const rect = viewport.getBoundingClientRect();
		this.pan.x = rect.width / 2 - x * this.zoom;
		this.pan.y = rect.height / 2 - y * this.zoom;
		this.updateViewportTransform();
		this.scheduleViewStateSave(0);
	}

	private centerViewOnNode(nodeId: string): void {
		const node = this.canvasData.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		const cx = node.x + node.width / 2;
		const cy = node.y + node.height / 2;
		this.centerViewOnCanvasPoint(cx, cy);
	}

	private selectNodeById(nodeId: string): void {
		const node = this.canvasData.nodes.find((n) => n.id === nodeId);
		const wrapper = this.nodeWrappers.get(nodeId);
		const nodeEl = wrapper?.querySelector(".heinibal-canvas-node");
		if (!node || !wrapper || !(nodeEl instanceof HTMLElement)) return;
		this.selectNode(node, nodeEl, wrapper);
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

		const styleRow = editor.createDiv({ cls: "heinibal-panel-row" });
		styleRow.createSpan({ text: "Route", cls: "heinibal-panel-label", attr: { title: "Route style" } });
		const styleSelect = styleRow.createEl("select");
		const styleOptions: Array<{ value: EdgeStyle; label: string }> = [
			{ value: "curve", label: "Curve" },
			{ value: "straight", label: "Straight" },
			{ value: "elbow", label: "Elbow" },
		];
		for (const option of styleOptions) {
			styleSelect.createEl("option", { value: option.value, text: option.label });
		}
		styleSelect.value = edge.edgeStyle ?? "curve";

		const endRow = editor.createDiv({ cls: "heinibal-panel-row" });
		endRow.createSpan({ text: "Arrow", cls: "heinibal-panel-label", attr: { title: "Arrow type" } });
		const endSelect = endRow.createEl("select");
		const endMode = (edge.fromEnd ?? "none") === "arrow"
			? ((edge.toEnd ?? "arrow") === "arrow" ? "both" : "from")
			: ((edge.toEnd ?? "arrow") === "arrow" ? "to" : "none");
		const endOptions = [
			{ value: "to", label: "Single" },
			{ value: "both", label: "Double" },
			{ value: "none", label: "None" },
			{ value: "from", label: "Reverse" },
		];
		for (const option of endOptions) {
			endSelect.createEl("option", { value: option.value, text: option.label });
		}
		endSelect.value = endMode;

		const row = editor.createDiv({ cls: "heinibal-panel-row" });
		const saveBtn = row.createEl("button", { text: "Apply", attr: { title: "Apply" } });
		const clearBtn = row.createEl("button", { text: "Clear", attr: { title: "Clear label" } });

			const applyVisual = () => {
				edge.edgeStyle = styleSelect.value as EdgeStyle;
				if (edge.edgeStyle === "straight") {
					delete edge.controlX;
					delete edge.controlY;
				}
			switch (endSelect.value) {
				case "both":
					edge.fromEnd = "arrow";
					edge.toEnd = "arrow";
					break;
				case "none":
					edge.fromEnd = "none";
					edge.toEnd = "none";
					break;
				case "from":
					edge.fromEnd = "arrow";
					edge.toEnd = "none";
					break;
				default:
					edge.fromEnd = "none";
					edge.toEnd = "arrow";
					break;
			}
			this.renderEdges();
		};

		const apply = () => {
			edge.label = input.value.trim() || undefined;
			applyVisual();
			void this.saveCanvasData();
			this.closeEdgeLabelEditor();
		};
		styleSelect.onchange = applyVisual;
		endSelect.onchange = applyVisual;

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
		const previousIds = [...this.selectedNodeIds];
		for (const id of previousIds) {
			this.nodeWrappers.get(id)?.removeClass("is-selected");
			this.refreshNodeCardById(id);
		}
		this.selectedNodeIds.clear();
		this.selectedNodeId = null;
	}

	private setSelectedNodeIds(nodeIds: string[]): void {
		const uniqueIds = [...new Set(nodeIds.filter((id) => !!id))];
		this.clearSelection();
		for (const id of uniqueIds) {
			this.selectedNodeIds.add(id);
			this.nodeWrappers.get(id)?.addClass("is-selected");
		}
		this.selectedNodeId = uniqueIds.length === 1 ? (uniqueIds[0] ?? null) : null;
		if (uniqueIds.length !== 1) {
			this.hideSubmenu();
		}
	}

	private refreshNodeCardById(nodeId: string): void {
		const node = this.canvasData.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		const wrapper = this.nodesContainer?.querySelector(`.heinibal-node-wrapper[data-node-id="${nodeId}"]`);
		if (!wrapper) return;
		const nodeEl = wrapper.querySelector(".heinibal-canvas-node");
		if (!nodeEl) return;
		if (!(nodeEl instanceof HTMLElement)) return;
		nodeEl.empty();
		if (node.type === "file") this.renderFileCard(nodeEl, node);
		else if (node.type === "text") this.renderTextNode(nodeEl, node);
		else if (node.type === "group") this.renderGroupNode(nodeEl, node);
		else if (node.type === "link") this.renderLinkNode(nodeEl, node);
	}

	private deleteNodeById(nodeId: string, shouldPersist = true): void {
		const index = this.canvasData.nodes.findIndex((n) => n.id === nodeId);
		if (index < 0) return;
		this.canvasData.nodes.splice(index, 1);
		this.canvasData.edges = this.canvasData.edges.filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId);
		const wrapper = this.nodesContainer?.querySelector(`.heinibal-node-wrapper[data-node-id="${nodeId}"]`);
		wrapper?.remove();
		this.nodeWrappers.delete(nodeId);
		if (this.selectedNodeIds.has(nodeId)) {
			this.selectedNodeIds.delete(nodeId);
			this.hideSubmenu();
			this.closeDetailLeaf();
			this.selectedNodeId = null;
		}
		this.renderEdges();
		if (shouldPersist) void this.saveCanvasData();
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

		s.wrapper.setCssProps({
			left: `${x}px`,
			top: `${y}px`,
		});
		s.wrapper.style.width = `${width}px`;
		s.wrapper.style.height = `${height}px`;
		s.nodeEl.style.width = `${width}px`;
		s.nodeEl.style.height = `${height}px`;
		this.renderEdges();
	}

	private renderNode(node: AllCanvasNodeData): void {
		const wrapper = this.nodesContainer.createDiv({ cls: "heinibal-node-wrapper" });
		wrapper.dataset.nodeId = node.id ?? "";
		this.nodeWrappers.set(node.id, wrapper);
		if (node.type === "group") wrapper.addClass("is-group");

		const nodeEl = wrapper.createDiv({ cls: "heinibal-canvas-node" });
		nodeEl.style.width = `${node.width}px`;
		nodeEl.style.height = `${node.height}px`;

		wrapper.setCssProps({
			left: `${node.x}px`,
			top: `${node.y}px`,
		});
		wrapper.style.width = `${node.width}px`;
		wrapper.style.height = `${node.height}px`;

		const borderColor = this.resolveColor(node.color);
		nodeEl.style.borderLeftColor = borderColor;
		this.applyShape(nodeEl, node.shape);

		if (node.type === "file") {
			this.renderFileCard(nodeEl, node);
		} else if (node.type === "text") {
			this.renderTextNode(nodeEl, node);
		} else if (node.type === "group") {
			this.renderGroupNode(nodeEl, node);
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
		});

		this.registerDomEvent(nodeEl, "mouseup", (e: MouseEvent) => {
			if (e.button !== 0) return;
			const wasDragging = this.didDragThisPointer || this.isDraggingNodes();
			if (!wasDragging) {
				if (this.selectedNodeIds.size === 1 && this.selectedNodeIds.has(node.id)) {
					this.hideSubmenu();
					this.clearSelection();
					this.closeDetailLeaf();
				} else {
					this.selectNode(node, nodeEl, wrapper);
				}
			}
			this.nodeMouseDownPos = null;
			this.nodeMouseDownId = null;
			this.didDragThisPointer = false;
		});

		this.registerDomEvent(nodeEl, "contextmenu", (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.selectedNodeIds.size === 1 && this.selectedNodeIds.has(node.id)) {
				this.hideSubmenu();
				this.clearSelection();
				this.closeDetailLeaf();
			} else {
				this.selectNode(node, nodeEl, wrapper);
			}
		});
	}

	private beginNodeDrag(node: AllCanvasNodeData, pointerClientX: number, pointerClientY: number): void {
		this.draggedNodeIds.clear();
		this.dragNodeStartPositions.clear();
		this.dragStartPointerCanvas = this.clientToCanvas(pointerClientX, pointerClientY);

		const baseDragIds = this.selectedNodeIds.has(node.id) && this.selectedNodeIds.size > 0
			? [...this.selectedNodeIds]
			: [node.id];
		for (const id of baseDragIds) this.draggedNodeIds.add(id);

		const draggedSnapshot = new Set(this.draggedNodeIds);
		for (const draggedId of [...draggedSnapshot]) {
			const draggedNode = this.canvasData.nodes.find((n) => n.id === draggedId);
			if (!draggedNode || draggedNode.type !== "group") continue;
			for (const childId of this.getGroupChildNodeIds(draggedNode)) {
				this.draggedNodeIds.add(childId);
			}
		}

		for (const draggedId of this.draggedNodeIds) {
			const draggedNode = this.canvasData.nodes.find((n) => n.id === draggedId);
			if (!draggedNode) continue;
			this.dragNodeStartPositions.set(draggedId, { x: draggedNode.x, y: draggedNode.y });
		}
	}

	private isDraggingNodes(): boolean {
		return this.draggedNodeIds.size > 0 && this.dragStartPointerCanvas !== null;
	}

	private applyNodeDrag(e: MouseEvent): void {
		if (!this.dragStartPointerCanvas) return;
		const pointerCanvas = this.clientToCanvas(e.clientX, e.clientY);
		const dx = pointerCanvas.x - this.dragStartPointerCanvas.x;
		const dy = pointerCanvas.y - this.dragStartPointerCanvas.y;
		for (const nodeId of this.draggedNodeIds) {
			const node = this.canvasData.nodes.find((n) => n.id === nodeId);
			const start = this.dragNodeStartPositions.get(nodeId);
			if (!node || !start) continue;
			node.x = start.x + dx;
			node.y = start.y + dy;
			const wrapper = this.nodeWrappers.get(nodeId);
			if (wrapper) {
				wrapper.setCssProps({
					left: `${node.x}px`,
					top: `${node.y}px`,
				});
			}
		}
		this.renderEdges();
	}

	private getGroupChildNodeIds(groupNode: AllCanvasNodeData): string[] {
		if (groupNode.type !== "group") return [];
		const right = groupNode.x + groupNode.width;
		const bottom = groupNode.y + groupNode.height;
		return this.canvasData.nodes
			.filter((n) => {
				if (n.id === groupNode.id) return false;
				const nr = n.x + n.width;
				const nb = n.y + n.height;
				return n.x >= groupNode.x && n.y >= groupNode.y && nr <= right && nb <= bottom;
			})
			.map((n) => n.id);
	}

	private startMarqueeSelection(e: MouseEvent, viewport: HTMLElement): void {
		this.isMarqueeSelecting = true;
		this.marqueeStartClient = { x: e.clientX, y: e.clientY };
		this.marqueeCurrentClient = { x: e.clientX, y: e.clientY };
		this.marqueeStartCanvas = this.clientToCanvas(e.clientX, e.clientY);
		this.marqueeCurrentCanvas = this.marqueeStartCanvas;
		this.marqueeEl?.remove();
		this.marqueeEl = viewport.createDiv({ cls: "heinibal-marquee-selection" });
		this.updateMarqueeElement(viewport);
	}

	private updateMarqueeSelection(e: MouseEvent, viewport: HTMLElement): void {
		if (!this.isMarqueeSelecting || !this.marqueeStartCanvas) return;
		this.marqueeCurrentClient = { x: e.clientX, y: e.clientY };
		this.marqueeCurrentCanvas = this.clientToCanvas(e.clientX, e.clientY);
		this.updateMarqueeElement(viewport);
		const bounds = this.getCanvasMarqueeBounds();
		if (!bounds) return;
		const selectedIds = this.canvasData.nodes
			.filter((node) =>
				node.x < bounds.maxX &&
				node.x + node.width > bounds.minX &&
				node.y < bounds.maxY &&
				node.y + node.height > bounds.minY
			)
			.map((node) => node.id);
		this.setSelectedNodeIds(selectedIds);
	}

	private finishMarqueeSelection(): void {
		this.isMarqueeSelecting = false;
		this.marqueeStartClient = null;
		this.marqueeCurrentClient = null;
		this.marqueeStartCanvas = null;
		this.marqueeCurrentCanvas = null;
		this.marqueeEl?.remove();
		this.marqueeEl = null;
	}

	private updateMarqueeElement(viewport: HTMLElement): void {
		if (!this.marqueeEl || !this.marqueeStartClient || !this.marqueeCurrentClient) return;
		const rect = viewport.getBoundingClientRect();
		const left = Math.min(this.marqueeStartClient.x, this.marqueeCurrentClient.x) - rect.left;
		const top = Math.min(this.marqueeStartClient.y, this.marqueeCurrentClient.y) - rect.top;
		const width = Math.abs(this.marqueeCurrentClient.x - this.marqueeStartClient.x);
		const height = Math.abs(this.marqueeCurrentClient.y - this.marqueeStartClient.y);
		this.marqueeEl.style.left = `${left}px`;
		this.marqueeEl.style.top = `${top}px`;
		this.marqueeEl.style.width = `${width}px`;
		this.marqueeEl.style.height = `${height}px`;
	}

	private getCanvasMarqueeBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
		if (!this.marqueeStartCanvas || !this.marqueeCurrentCanvas) return null;
		return {
			minX: Math.min(this.marqueeStartCanvas.x, this.marqueeCurrentCanvas.x),
			minY: Math.min(this.marqueeStartCanvas.y, this.marqueeCurrentCanvas.y),
			maxX: Math.max(this.marqueeStartCanvas.x, this.marqueeCurrentCanvas.x),
			maxY: Math.max(this.marqueeStartCanvas.y, this.marqueeCurrentCanvas.y),
		};
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
		this.tempEdgeContainer.addClass("heinibal-temp-edge-passive");
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
		this.setSelectedNodeIds([node.id]);
		this.refreshNodeCardById(node.id);

		if (node.type === "file") {
			const file = this.app.vault.getAbstractFileByPath(node.file);
			if (file instanceof TFile) {
				void this.openFileInRightPane(file);
			}
		}

		this.showSubmenuBelowCard(node, nodeEl, wrapper);
	}

	private showSubmenuBelowCard(node: AllCanvasNodeData, nodeEl: HTMLElement, wrapper: HTMLElement): void {
		this.hideSubmenu();
		const panel = wrapper.createDiv({ cls: "heinibal-card-submenu" });
		const stopBubble = (e: MouseEvent): void => {
			e.stopPropagation();
		};
		this.registerDomEvent(panel, "mousedown", stopBubble);
		this.registerDomEvent(panel, "mouseup", stopBubble);
		this.registerDomEvent(panel, "click", stopBubble);
		this.registerDomEvent(panel, "contextmenu", stopBubble);
		this.addNodeContentEditor(panel, node, nodeEl);

		const appearanceRow = panel.createDiv({ cls: "heinibal-panel-row" });
		const appearanceBtn = appearanceRow.createEl("button", { text: "Style", attr: { title: "Appearance" } });
		const stylePanel = panel.createDiv({ cls: "heinibal-submenu-panel" });
		appearanceBtn.onclick = () => stylePanel.classList.toggle("is-open");

		const presetColors = ["1", "2", "3", "4", "5", "6"];
		const colorRow = stylePanel.createDiv({ cls: "heinibal-panel-row" });
		colorRow.createSpan({ text: "Color", cls: "heinibal-panel-label", attr: { title: "Color" } });
		for (const c of presetColors) {
			const btn = colorRow.createEl("button", { cls: "heinibal-color-btn" });
			btn.style.backgroundColor = CANVAS_COLORS[c] ?? c;
			btn.onclick = () => {
				this.setNodeColor(node, nodeEl, CANVAS_COLORS[c] ?? c);
				const hex = this.nodeColorToHex(node);
				customColor.value = hex;
				customHex.value = hex;
			};
		}
		const customColor = colorRow.createEl("input", { attr: { type: "color" } });
		customColor.className = "heinibal-color-custom";
		const customHex = colorRow.createEl("input", { type: "text", cls: "heinibal-color-hex" });
		customHex.placeholder = "#rrggbb";
		const initialHex = this.nodeColorToHex(node);
		customColor.value = initialHex;
		customHex.value = initialHex;
		customColor.oninput = () => {
			const hex = customColor.value;
			this.setNodeColor(node, nodeEl, hex);
			customHex.value = hex;
		};
		customHex.oninput = () => {
			const raw = customHex.value.trim();
			if (!this.isValidHexColor(raw)) return;
			const normalized = this.normalizeHexColor(raw);
			this.setNodeColor(node, nodeEl, normalized);
			customColor.value = normalized;
			customHex.value = normalized;
		};

		const shapeRow = stylePanel.createDiv({ cls: "heinibal-panel-row" });
		shapeRow.createSpan({ text: "Shape", cls: "heinibal-panel-label", attr: { title: "Shape" } });
		const shapes: NodeShape[] = ["rectangle", "rounded", "pill"];
		for (const s of shapes) {
			const btn = shapeRow.createEl("button", { text: s });
			btn.onclick = () => this.setNodeShape(node, nodeEl, s);
		}

		if (node.type === "file") {
			const file = this.app.vault.getAbstractFileByPath(node.file);
			if (file instanceof TFile) {
				const openBtn = panel.createEl("button", { text: "Open", title: "Open in right pane" });
				openBtn.onclick = () => this.openFileInRightPane(file);
			}
		}

		const deleteBtn = panel.createEl("button", { text: "Delete", cls: "heinibal-panel-delete", attr: { title: "Delete card" } });
		deleteBtn.onclick = () => {
			this.hideSubmenu();
			this.deleteNodeById(node.id);
		};
		this.selectedSubmenuEl = panel;
	}

	private addNodeContentEditor(panel: HTMLElement, node: AllCanvasNodeData, nodeEl: HTMLElement): void {
		const row = panel.createDiv({ cls: "heinibal-panel-row heinibal-panel-content-row" });
		row.createSpan({ text: "Content", cls: "heinibal-panel-label", attr: { title: "Content" } });

		if (node.type === "file") {
			const input = row.createEl("input", { type: "text", placeholder: "Card title override" });
			input.value = String((node as CanvasFileData & { title?: string }).title ?? "");
			input.oninput = () => {
				(node as CanvasFileData & { title?: string }).title = input.value.trim() || undefined;
				const titleEl = nodeEl.querySelector(".heinibal-file-title");
				if (titleEl) titleEl.textContent = this.getFileNodeDisplayTitle(node);
				void this.saveCanvasData();
			};
			return;
		}

		if (node.type === "text") {
			const input = row.createEl("textarea", { cls: "heinibal-panel-textarea" });
			input.value = String((node).text ?? "");
			input.oninput = () => {
				(node).text = input.value;
				const textEl = nodeEl.querySelector(".heinibal-text-content");
				if (textEl) textEl.textContent = input.value;
				void this.saveCanvasData();
			};
			return;
		}

		if (node.type === "group") {
			const input = row.createEl("input", { type: "text", placeholder: "Group name" });
			input.value = (node).label ?? "";
			input.oninput = () => {
				(node).label = input.value.trim() || "Group";
				const labelEl = nodeEl.querySelector(".heinibal-node-label");
				if (labelEl) labelEl.textContent = (node).label ?? "Group";
				void this.saveCanvasData();
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
				void this.saveCanvasData();
			};
		}
	}

	private nodeColorToHex(node: AllCanvasNodeData): string {
		const c = node.color;
		if (c?.startsWith("#") && this.isValidHexColor(c)) return this.normalizeHexColor(c);
		if (c?.startsWith("rgb")) {
			const converted = this.rgbToHex(c);
			if (converted) return converted;
		}
		const preset = c ? CANVAS_COLORS[c] : null;
		if (preset && preset.startsWith("var(")) {
			const varName = preset.replace(/^var\(|\)$/g, "").trim();
			const style = getComputedStyle(document.body);
			const val = style.getPropertyValue(varName).trim();
			if (val) {
				const converted = this.rgbToHex(val);
				if (converted) return converted;
				if (this.isValidHexColor(val)) return this.normalizeHexColor(val);
			}
		}
		return "#7c3aed";
	}

	private isValidHexColor(value: string): boolean {
		return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
	}

	private normalizeHexColor(value: string): string {
		const v = value.trim();
		if (v.length === 4) {
			const r = v[1];
			const g = v[2];
			const b = v[3];
			return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
		}
		return v.toLowerCase();
	}

	private rgbToHex(value: string): string | null {
		const match = value.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if (!match) return null;
		const toHex = (n: number) => n.toString(16).padStart(2, "0");
		const r = Math.min(255, Number(match[1]));
		const g = Math.min(255, Number(match[2]));
		const b = Math.min(255, Number(match[3]));
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	private setNodeColor(node: AllCanvasNodeData, nodeEl: HTMLElement, hexOrVar: string): void {
		node.color = hexOrVar;
		nodeEl.style.borderLeftColor = hexOrVar;
		if (node.type === "group") {
			const bg = this.resolveColor(node.color);
			nodeEl.style.backgroundColor = `${bg}22`;
		}
		void this.saveCanvasData();
	}

	private setNodeShape(node: AllCanvasNodeData, nodeEl: HTMLElement, shape: NodeShape): void {
		node.shape = shape;
		this.applyShape(nodeEl, shape);
		void this.saveCanvasData();
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
		const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
		const frontmatterTitle = frontmatter?.["title"];
		return typeof frontmatterTitle === "string" && frontmatterTitle.trim().length > 0
			? frontmatterTitle
			: file.basename;
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
		const bg = this.resolveColor(node.color);
		container.style.backgroundColor = `${bg}20`;
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
		const content = modal.createDiv({ cls: "heinibal-modal-content" });
		content.createEl("h3", { text: "Add files to canvas" });
		const search = content.createEl("input", {
			type: "text",
			cls: "heinibal-file-search",
			placeholder: "Search by file name",
		});
		const list = content.createDiv({ cls: "heinibal-file-list" });
		const closeBtn = content.createEl("button", { text: "Close", cls: "heinibal-modal-close" });

		const renderList = (query: string): void => {
			list.empty();
			const q = query.trim().toLowerCase();
			const available = files.filter((file) => !existingPaths.has(file.path));
			const sorted = q
				? available
					.filter((file) => {
						const base = file.basename.toLowerCase();
						const path = file.path.toLowerCase();
						return base.includes(q) || path.includes(q);
					})
					.sort((a, b) => {
						const aPrefix = a.basename.toLowerCase().startsWith(q) ? 0 : 1;
						const bPrefix = b.basename.toLowerCase().startsWith(q) ? 0 : 1;
						return aPrefix - bPrefix || a.path.localeCompare(b.path);
					})
				: available.sort((a, b) => a.path.localeCompare(b.path));

			for (const file of sorted) {
				const item = list.createEl("div", { cls: "heinibal-file-list-item" });
				item.textContent = file.path;
				item.onclick = () => {
					this.addFileToCanvas(file);
					existingPaths.add(file.path);
					this.autoLinkImportedFiles([file.path]);
					renderList(search.value);
				};
			}
		};

		search.addEventListener("input", () => renderList(search.value));
		search.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			const firstItem = list.querySelector<HTMLElement>(".heinibal-file-list-item");
			if (firstItem) firstItem.click();
		});
		renderList("");
		closeBtn.addEventListener("click", () => modal.remove());
		modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
		document.body.appendChild(modal);
	}

	private showCanvasNodeListModal(): void {
		const modal = document.createElement("div");
		modal.className = "heinibal-add-files-modal";
		const content = modal.createDiv({ cls: "heinibal-modal-content" });
		content.createEl("h3", { text: "Cards on canvas" });
		const search = content.createEl("input", {
			type: "text",
			cls: "heinibal-file-search",
			placeholder: "Search cards",
		});
		const list = content.createDiv({ cls: "heinibal-file-list" });
		const closeBtn = content.createEl("button", { text: "Close", cls: "heinibal-modal-close" });

		const cards = this.canvasData.nodes.filter((n) => n.type !== "group");
		const renderList = (query: string): void => {
			list.empty();
			const q = query.trim().toLowerCase();
			const filtered = cards
				.filter((node) => {
					const title = this.getNodeListTitle(node).toLowerCase();
					return q.length === 0 || title.includes(q);
				})
				.sort((a, b) => this.getNodeListTitle(a).localeCompare(this.getNodeListTitle(b)));

			for (const node of filtered) {
				const row = list.createEl("div", { cls: "heinibal-file-list-item" });
				const title = this.getNodeListTitle(node);
				const subtitle = row.createEl("div", { cls: "heinibal-node-list-subtitle" });
				subtitle.textContent = node.type === "file" ? node.file : node.type;
				row.createEl("div", { text: title, cls: "heinibal-node-list-title" });
				row.appendChild(subtitle);

				const actions = row.createEl("div", { cls: "heinibal-node-list-actions" });
				const locateBtn = actions.createEl("button", { text: "Locate" });
				const openBtn = actions.createEl("button", { text: "Open" });
				locateBtn.onclick = (ev) => {
					ev.stopPropagation();
					this.centerViewOnNode(node.id);
				};
				openBtn.onclick = (ev) => {
					ev.stopPropagation();
					this.centerViewOnNode(node.id);
					this.selectNodeById(node.id);
					modal.remove();
				};
				row.onclick = () => {
					this.centerViewOnNode(node.id);
				};
			}
		};

		search.addEventListener("input", () => renderList(search.value));
		renderList("");
		closeBtn.addEventListener("click", () => modal.remove());
		modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
		document.body.appendChild(modal);
	}

	private getNodeListTitle(node: AllCanvasNodeData): string {
		if (node.type === "file") {
			return this.getFileNodeDisplayTitle(node);
		}
		if (node.type === "text") {
			return (node.text || "Text").slice(0, 40);
		}
		if (node.type === "link") {
			return node.url || "Link";
		}
		return node.type;
	}

	private getElbowPath(
		edge: CanvasEdgeData,
		fromPt: { x: number; y: number },
		toPt: { x: number; y: number },
		fromSide: NodeSide,
		toSide: NodeSide
	): { d: string; label: { x: number; y: number }; handle: { x: number; y: number } } {
		const fromHorizontal = fromSide === "left" || fromSide === "right";
		const toHorizontal = toSide === "left" || toSide === "right";
		const control = (typeof edge.controlX === "number" && typeof edge.controlY === "number")
			? { x: edge.controlX, y: edge.controlY }
			: fromHorizontal !== toHorizontal
				? {
					x: fromHorizontal ? toPt.x : fromPt.x,
					y: fromHorizontal ? fromPt.y : toPt.y,
				}
				: {
					x: (fromPt.x + toPt.x) / 2,
					y: (fromPt.y + toPt.y) / 2,
				};

		const p1 = fromHorizontal
			? { x: control.x, y: fromPt.y }
			: { x: fromPt.x, y: control.y };
		const p2 = toHorizontal
			? { x: control.x, y: toPt.y }
			: { x: toPt.x, y: control.y };

		const d = `M ${fromPt.x} ${fromPt.y} L ${p1.x} ${p1.y} L ${control.x} ${control.y} L ${p2.x} ${p2.y} L ${toPt.x} ${toPt.y}`;
		return {
			d,
			label: { x: control.x, y: control.y },
			handle: { x: control.x, y: control.y },
		};
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
		void this.saveCanvasData();
	}

	private createEdgeId(): string {
		return `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	}

	private hasDirectedEdge(fromNodeId: string, toNodeId: string): boolean {
		return this.canvasData.edges.some((edge) => edge.fromNode === fromNodeId && edge.toNode === toNodeId);
	}

	private getOutgoingLinkPaths(filePath: string): Set<string> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return new Set();
		const cache = this.app.metadataCache.getFileCache(file);
		const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
		const out = new Set<string>();
		for (const link of links) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
			if (dest) out.add(dest.path);
		}
		return out;
	}

	private autoLinkImportedFiles(addedPaths: string[]): void {
		if (addedPaths.length === 0) return;
		const fileNodes = this.canvasData.nodes.filter((n): n is CanvasFileData => n.type === "file");
		if (fileNodes.length === 0) return;
		const nodesByPath = new Map<string, CanvasFileData>();
		for (const node of fileNodes) {
			if (!nodesByPath.has(node.file)) nodesByPath.set(node.file, node);
		}
		const entries = [...nodesByPath.entries()];
		const addedSet = new Set(addedPaths);
		const outgoingCache = new Map<string, Set<string>>();
		const getOutgoing = (path: string): Set<string> => {
			const cached = outgoingCache.get(path);
			if (cached) return cached;
			const outgoing = this.getOutgoingLinkPaths(path);
			outgoingCache.set(path, outgoing);
			return outgoing;
		};
		let changed = false;
		for (const [sourcePath, sourceNode] of entries) {
			const outgoing = getOutgoing(sourcePath);
			for (const targetPath of outgoing) {
				const targetNode = nodesByPath.get(targetPath);
				if (!targetNode) continue;
				if (sourceNode.id === targetNode.id) continue;
				if (!addedSet.has(sourcePath) && !addedSet.has(targetPath)) continue;

				const hasReverseLink = getOutgoing(targetPath).has(sourcePath);
				const existingForward = this.canvasData.edges.find(
					(edge) => edge.fromNode === sourceNode.id && edge.toNode === targetNode.id
				);
				const existingBackward = this.canvasData.edges.find(
					(edge) => edge.fromNode === targetNode.id && edge.toNode === sourceNode.id
				);

				if (hasReverseLink) {
					const existing = existingForward ?? existingBackward;
					if (existing) {
						if (existing.fromEnd !== "arrow" || existing.toEnd !== "arrow") {
							existing.fromEnd = "arrow";
							existing.toEnd = "arrow";
							changed = true;
						}
						continue;
					}
					this.canvasData.edges.push({
						id: this.createEdgeId(),
						fromNode: sourceNode.id,
						fromSide: "right",
						fromOffset: 0.5,
						toNode: targetNode.id,
						toSide: "left",
						toOffset: 0.5,
						fromEnd: "arrow",
						toEnd: "arrow",
						edgeStyle: "curve",
					});
					changed = true;
					continue;
				}

				if (this.hasDirectedEdge(sourceNode.id, targetNode.id)) continue;
				this.canvasData.edges.push({
					id: this.createEdgeId(),
					fromNode: sourceNode.id,
					fromSide: "right",
					fromOffset: 0.5,
					toNode: targetNode.id,
					toSide: "left",
					toOffset: 0.5,
					fromEnd: "none",
					toEnd: "arrow",
					edgeStyle: "curve",
				});
				changed = true;
			}
		}
		if (changed) {
			this.renderEdges();
			void this.saveCanvasData();
		}
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
		void this.saveCanvasData();
	}
}



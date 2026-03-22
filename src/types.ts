/**
 * Canvas data types compatible with Obsidian canvas format
 */

export type CanvasColor = string;

export type NodeShape = 'rectangle' | 'rounded' | 'pill';

export interface CanvasNodeData {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: CanvasColor;
	shape?: NodeShape;
	[key: string]: unknown;
}

export interface CanvasFileData extends CanvasNodeData {
	type: 'file';
	file: string;
	subpath?: string;
}

export interface CanvasTextData extends CanvasNodeData {
	type: 'text';
	text: string;
}

export interface CanvasLinkData extends CanvasNodeData {
	type: 'link';
	url: string;
}

export interface CanvasGroupData extends CanvasNodeData {
	type: 'group';
	label?: string;
	background?: string;
}

export type AllCanvasNodeData = CanvasFileData | CanvasTextData | CanvasLinkData | CanvasGroupData;

export type NodeSide = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';
export type EdgeStyle = 'curve' | 'straight' | 'elbow';

export interface CanvasEdgeData {
	id: string;
	fromNode: string;
	fromSide?: NodeSide;
	fromEnd?: EdgeEnd;
	toNode: string;
	toSide?: NodeSide;
	/** 0-1 position along toSide (e.g. 0.5 = center) */
	toOffset?: number;
	fromOffset?: number;
	toEnd?: EdgeEnd;
	edgeStyle?: EdgeStyle;
	color?: CanvasColor;
	label?: string;
	/** 0 = straight, positive = curve amount (e.g. 0.2-0.5) */
	curvature?: number;
	/** Manual edge control point in canvas coordinates (Figma-like bend point) */
	controlX?: number;
	controlY?: number;
	[key: string]: unknown;
}

export interface CanvasData {
	nodes: AllCanvasNodeData[];
	edges: CanvasEdgeData[];
	viewState?: {
		panX?: number;
		panY?: number;
		zoom?: number;
	};
	[key: string]: unknown;
}

export interface CanvasInfo {
	id: string;
	name: string;
	data: CanvasData;
}


/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { IModelDecorationOptions, IModelDecorationsChangeAccessor, IModelDeltaDecoration, ITextModel } from 'vs/editor/common/model';
import { FoldingRegion, FoldingRegions, ILineRange, FoldRange } from './foldingRanges';
import { hash } from 'vs/base/common/hash';

export interface IDecorationProvider {
	getDecorationOption(isCollapsed: boolean, isHidden: boolean): IModelDecorationOptions;
	deltaDecorations(oldDecorations: string[], newDecorations: IModelDeltaDecoration[]): string[];
	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null;
}

export interface FoldingModelChangeEvent {
	model: FoldingModel;
	collapseStateChanged?: FoldingRegion[];
}

interface ILineMemento extends ILineRange {
	checksum?: number;
}

export type CollapseMemento = ILineMemento[];

export class FoldingModel {
	private readonly _textModel: ITextModel;
	private readonly _decorationProvider: IDecorationProvider;
	private readonly _triggerRecomputeRanges: (() => void) | undefined;

	private _regions: FoldingRegions;
	private _editorDecorationIds: string[];

	private readonly _updateEventEmitter = new Emitter<FoldingModelChangeEvent>();
	public readonly onDidChange: Event<FoldingModelChangeEvent> = this._updateEventEmitter.event;

	public get regions(): FoldingRegions { return this._regions; }
	public get textModel() { return this._textModel; }
	public get decorationProvider() { return this._decorationProvider; }

	constructor(textModel: ITextModel, decorationProvider: IDecorationProvider, triggerRecomputeRanges?: () => void) {
		this._textModel = textModel;
		this._decorationProvider = decorationProvider;
		this._triggerRecomputeRanges = triggerRecomputeRanges;
		this._regions = new FoldingRegions(new Uint32Array(0), new Uint32Array(0));
		this._editorDecorationIds = [];
	}

	public toggleCollapseState(toggledRegions: FoldingRegion[]) {
		if (!toggledRegions.length) {
			return;
		}
		toggledRegions = toggledRegions.sort((r1, r2) => r1.regionIndex - r2.regionIndex);

		const processed: { [key: string]: boolean | undefined } = {};
		let anyExpanded = false;
		this._decorationProvider.changeDecorations(accessor => {
			let k = 0; // index from [0 ... this.regions.length]
			let dirtyRegionEndLine = -1; // end of the range where decorations need to be updated
			let lastHiddenLine = -1; // the end of the last hidden lines
			const updateDecorationsUntil = (index: number) => {
				while (k < index) {
					const endLineNumber = this._regions.getEndLineNumber(k);
					const isCollapsed = this._regions.isCollapsed(k);
					if (endLineNumber <= dirtyRegionEndLine) {
						accessor.changeDecorationOptions(this._editorDecorationIds[k], this._decorationProvider.getDecorationOption(isCollapsed, endLineNumber <= lastHiddenLine));
					}
					if (isCollapsed && endLineNumber > lastHiddenLine) {
						lastHiddenLine = endLineNumber;
					}
					k++;
				}
			};
			for (let region of toggledRegions) {
				let index = region.regionIndex;
				let editorDecorationId = this._editorDecorationIds[index];
				if (editorDecorationId && !processed[editorDecorationId]) {
					processed[editorDecorationId] = true;

					updateDecorationsUntil(index); // update all decorations up to current index using the old dirtyRegionEndLine

					let newCollapseState = !this._regions.isCollapsed(index);
					if (!newCollapseState) {
						anyExpanded = true;
					}
					this._regions.setCollapsed(index, newCollapseState);

					dirtyRegionEndLine = Math.max(dirtyRegionEndLine, this._regions.getEndLineNumber(index));
				}
			}
			updateDecorationsUntil(this._regions.length);
		});
		this._updateEventEmitter.fire({ model: this, collapseStateChanged: toggledRegions });
		if (anyExpanded && this._triggerRecomputeRanges) {
			// expanding a range which didn't originate from range provider might now enable ranges
			// from the provider which were previously dropped due to the collapsed range
			this._triggerRecomputeRanges();
		}
	}

	public update(newRegions: FoldingRegions, blockedLineNumers: number[] = []): void {
		const hiddenRanges = this._currentHiddenRegions(blockedLineNumers);
		const newRanges = FoldingRegions.sanitizeAndMerge(newRegions, hiddenRanges, this._textModel.getLineCount());
		this.updatePost(FoldingRegions.fromFoldRanges(newRanges));
	}

	public updatePost(newRegions: FoldingRegions) {
		let newEditorDecorations: IModelDeltaDecoration[] = [];
		let lastHiddenLine = -1;
		for (let index = 0, limit = newRegions.length; index < limit; index++) {
			const startLineNumber = newRegions.getStartLineNumber(index);
			const endLineNumber = newRegions.getEndLineNumber(index);
			const isCollapsed = newRegions.isCollapsed(index);
			const decorationRange = {
				startLineNumber: startLineNumber,
				startColumn: this._textModel.getLineMaxColumn(startLineNumber),
				endLineNumber: endLineNumber,
				endColumn: this._textModel.getLineMaxColumn(endLineNumber) + 1
			};
			newEditorDecorations.push({ range: decorationRange, options: this._decorationProvider.getDecorationOption(isCollapsed, endLineNumber <= lastHiddenLine) });
			if (isCollapsed && endLineNumber > lastHiddenLine) {
				lastHiddenLine = endLineNumber;
			}
		}
		this._editorDecorationIds = this._decorationProvider.deltaDecorations(this._editorDecorationIds, newEditorDecorations);
		this._regions = newRegions;
		this._updateEventEmitter.fire({ model: this });
	}

	private _currentHiddenRegions(blockedLineNumers: number[] = []): FoldRange[] {

		let isBlocked = (startLineNumber: number, endLineNumber: number) => {
			for (let blockedLineNumber of blockedLineNumers) {
				if (startLineNumber < blockedLineNumber && blockedLineNumber <= endLineNumber) { // first line is visible
					return true;
				}
			}
			return false;
		};

		let hiddenRanges: FoldRange[] = [];
		for (let i = 0, limit = this._regions.length; i < limit; i++) {
			if (this.regions.isCollapsed(i)) {
				const hiddenRange = this._regions.toFoldRange(i);
				let decRange = this._textModel.getDecorationRange(this._editorDecorationIds[i]);
				if (decRange
					&& !isBlocked(decRange.startLineNumber, decRange.endLineNumber)
					&& decRange.endLineNumber > decRange.startLineNumber) {
					hiddenRanges.push({
						startLineNumber: decRange.startLineNumber,
						endLineNumber: decRange.endLineNumber,
						isCollapsed: true,
						type: hiddenRange.type
					});
				}
			}
		}

		return hiddenRanges;
	}

	/**
	 * Collapse state memento, for persistence only
	 */
	public getMemento(): CollapseMemento | undefined {
		const hiddenRegions = this._currentHiddenRegions();
		let result: ILineMemento[] = [];
		for (let i = 0, limit = hiddenRegions.length; i < limit; i++) {
			const range = hiddenRegions[i];
			const checksum = this._getLinesChecksum(range.startLineNumber + 1, range.endLineNumber);
			result.push({
				startLineNumber: range.startLineNumber,
				endLineNumber: range.endLineNumber,
				checksum: checksum
			});
		}
		return (result.length > 0) ? result : undefined;
	}

	/**
	 * Apply persisted state, for persistence only
	 */
	public applyMemento(state: CollapseMemento) {
		if (!Array.isArray(state)) {
			return;
		}
		let hiddenRanges: FoldRange[] = [];
		const maxLineNumber = this._textModel.getLineCount();
		for (let range of state) {
			if (range.startLineNumber >= range.endLineNumber || range.startLineNumber < 1 || range.endLineNumber > maxLineNumber) {
				continue;
			}
			const checksum = this._getLinesChecksum(range.startLineNumber + 1, range.endLineNumber);
			if (!range.checksum || checksum === range.checksum) {
				hiddenRanges.push({
					startLineNumber: range.startLineNumber,
					endLineNumber: range.endLineNumber,
					isCollapsed: true,
					type: undefined
				});
			}
		}

		const newRanges = FoldingRegions.sanitizeAndMerge(this._regions, hiddenRanges, maxLineNumber);
		this.updatePost(FoldingRegions.fromFoldRanges(newRanges));
	}

	private _getLinesChecksum(lineNumber1: number, lineNumber2: number): number {
		const h = hash(this._textModel.getLineContent(lineNumber1)
			+ this._textModel.getLineContent(lineNumber2));
		return h % 1000000; // 6 digits is plenty
	}

	public dispose() {
		this._decorationProvider.deltaDecorations(this._editorDecorationIds, []);
	}

	getAllRegionsAtLine(lineNumber: number, filter?: (r: FoldingRegion, level: number) => boolean): FoldingRegion[] {
		let result: FoldingRegion[] = [];
		if (this._regions) {
			let index = this._regions.findRange(lineNumber);
			let level = 1;
			while (index >= 0) {
				let current = this._regions.toRegion(index);
				if (!filter || filter(current, level)) {
					result.push(current);
				}
				level++;
				index = current.parentIndex;
			}
		}
		return result;
	}

	getRegionAtLine(lineNumber: number): FoldingRegion | null {
		if (this._regions) {
			let index = this._regions.findRange(lineNumber);
			if (index >= 0) {
				return this._regions.toRegion(index);
			}
		}
		return null;
	}

	getRegionsInside(region: FoldingRegion | null, filter?: RegionFilter | RegionFilterWithLevel): FoldingRegion[] {
		let result: FoldingRegion[] = [];
		let index = region ? region.regionIndex + 1 : 0;
		let endLineNumber = region ? region.endLineNumber : Number.MAX_VALUE;

		if (filter && filter.length === 2) {
			const levelStack: FoldingRegion[] = [];
			for (let i = index, len = this._regions.length; i < len; i++) {
				let current = this._regions.toRegion(i);
				if (this._regions.getStartLineNumber(i) < endLineNumber) {
					while (levelStack.length > 0 && !current.containedBy(levelStack[levelStack.length - 1])) {
						levelStack.pop();
					}
					levelStack.push(current);
					if (filter(current, levelStack.length)) {
						result.push(current);
					}
				} else {
					break;
				}
			}
		} else {
			for (let i = index, len = this._regions.length; i < len; i++) {
				let current = this._regions.toRegion(i);
				if (this._regions.getStartLineNumber(i) < endLineNumber) {
					if (!filter || (filter as RegionFilter)(current)) {
						result.push(current);
					}
				} else {
					break;
				}
			}
		}
		return result;
	}

}

type RegionFilter = (r: FoldingRegion) => boolean;
type RegionFilterWithLevel = (r: FoldingRegion, level: number) => boolean;


/**
 * Collapse or expand the regions at the given locations
 * @param levels The number of levels. Use 1 to only impact the regions at the location, use Number.MAX_VALUE for all levels.
 * @param lineNumbers the location of the regions to collapse or expand, or if not set, all regions in the model.
 */
export function toggleCollapseState(foldingModel: FoldingModel, levels: number, lineNumbers: number[]) {
	let toToggle: FoldingRegion[] = [];
	for (let lineNumber of lineNumbers) {
		let region = foldingModel.getRegionAtLine(lineNumber);
		if (region) {
			const doCollapse = !region.isCollapsed;
			toToggle.push(region);
			if (levels > 1) {
				let regionsInside = foldingModel.getRegionsInside(region, (r, level: number) => r.isCollapsed !== doCollapse && level < levels);
				toToggle.push(...regionsInside);
			}
		}
	}
	foldingModel.toggleCollapseState(toToggle);
}


/**
 * Collapse or expand the regions at the given locations including all children.
 * @param doCollapse Whether to collapse or expand
 * @param levels The number of levels. Use 1 to only impact the regions at the location, use Number.MAX_VALUE for all levels.
 * @param lineNumbers the location of the regions to collapse or expand, or if not set, all regions in the model.
 */
export function setCollapseStateLevelsDown(foldingModel: FoldingModel, doCollapse: boolean, levels = Number.MAX_VALUE, lineNumbers?: number[]): void {
	let toToggle: FoldingRegion[] = [];
	if (lineNumbers && lineNumbers.length > 0) {
		for (let lineNumber of lineNumbers) {
			let region = foldingModel.getRegionAtLine(lineNumber);
			if (region) {
				if (region.isCollapsed !== doCollapse) {
					toToggle.push(region);
				}
				if (levels > 1) {
					let regionsInside = foldingModel.getRegionsInside(region, (r, level: number) => r.isCollapsed !== doCollapse && level < levels);
					toToggle.push(...regionsInside);
				}
			}
		}
	} else {
		let regionsInside = foldingModel.getRegionsInside(null, (r, level: number) => r.isCollapsed !== doCollapse && level < levels);
		toToggle.push(...regionsInside);
	}
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Collapse or expand the regions at the given locations including all parents.
 * @param doCollapse Whether to collapse or expand
 * @param levels The number of levels. Use 1 to only impact the regions at the location, use Number.MAX_VALUE for all levels.
 * @param lineNumbers the location of the regions to collapse or expand.
 */
export function setCollapseStateLevelsUp(foldingModel: FoldingModel, doCollapse: boolean, levels: number, lineNumbers: number[]): void {
	let toToggle: FoldingRegion[] = [];
	for (let lineNumber of lineNumbers) {
		let regions = foldingModel.getAllRegionsAtLine(lineNumber, (region, level) => region.isCollapsed !== doCollapse && level <= levels);
		toToggle.push(...regions);
	}
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Collapse or expand a region at the given locations. If the inner most region is already collapsed/expanded, uses the first parent instead.
 * @param doCollapse Whether to collapse or expand
 * @param lineNumbers the location of the regions to collapse or expand.
 */
export function setCollapseStateUp(foldingModel: FoldingModel, doCollapse: boolean, lineNumbers: number[]): void {
	let toToggle: FoldingRegion[] = [];
	for (let lineNumber of lineNumbers) {
		let regions = foldingModel.getAllRegionsAtLine(lineNumber, (region,) => region.isCollapsed !== doCollapse);
		if (regions.length > 0) {
			toToggle.push(regions[0]);
		}
	}
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Folds or unfolds all regions that have a given level, except if they contain one of the blocked lines.
 * @param foldLevel level. Level == 1 is the top level
 * @param doCollapse Whether to collapse or expand
*/
export function setCollapseStateAtLevel(foldingModel: FoldingModel, foldLevel: number, doCollapse: boolean, blockedLineNumbers: number[]): void {
	let filter = (region: FoldingRegion, level: number) => level === foldLevel && region.isCollapsed !== doCollapse && !blockedLineNumbers.some(line => region.containsLine(line));
	let toToggle = foldingModel.getRegionsInside(null, filter);
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Folds or unfolds all regions, except if they contain or are contained by a region of one of the blocked lines.
 * @param doCollapse Whether to collapse or expand
 * @param blockedLineNumbers the location of regions to not collapse or expand
 */
export function setCollapseStateForRest(foldingModel: FoldingModel, doCollapse: boolean, blockedLineNumbers: number[]): void {
	let filteredRegions: FoldingRegion[] = [];
	for (let lineNumber of blockedLineNumbers) {
		const regions = foldingModel.getAllRegionsAtLine(lineNumber, undefined);
		if (regions.length > 0) {
			filteredRegions.push(regions[0]);
		}
	}
	let filter = (region: FoldingRegion) => filteredRegions.every((filteredRegion) => !filteredRegion.containedBy(region) && !region.containedBy(filteredRegion)) && region.isCollapsed !== doCollapse;
	let toToggle = foldingModel.getRegionsInside(null, filter);
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Folds all regions for which the lines start with a given regex
 * @param foldingModel the folding model
 */
export function setCollapseStateForMatchingLines(foldingModel: FoldingModel, regExp: RegExp, doCollapse: boolean): void {
	let editorModel = foldingModel.textModel;
	let regions = foldingModel.regions;
	let toToggle: FoldingRegion[] = [];
	for (let i = regions.length - 1; i >= 0; i--) {
		if (doCollapse !== regions.isCollapsed(i)) {
			let startLineNumber = regions.getStartLineNumber(i);
			if (regExp.test(editorModel.getLineContent(startLineNumber))) {
				toToggle.push(regions.toRegion(i));
			}
		}
	}
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Folds all regions of the given type
 * @param foldingModel the folding model
 */
export function setCollapseStateForType(foldingModel: FoldingModel, type: string, doCollapse: boolean): void {
	let regions = foldingModel.regions;
	let toToggle: FoldingRegion[] = [];
	for (let i = regions.length - 1; i >= 0; i--) {
		if (doCollapse !== regions.isCollapsed(i) && type === regions.getType(i)) {
			toToggle.push(regions.toRegion(i));
		}
	}
	foldingModel.toggleCollapseState(toToggle);
}

/**
 * Get line to go to for parent fold of current line
 * @param lineNumber the current line number
 * @param foldingModel the folding model
 *
 * @return Parent fold start line
 */
export function getParentFoldLine(lineNumber: number, foldingModel: FoldingModel): number | null {
	let startLineNumber: number | null = null;
	let foldingRegion = foldingModel.getRegionAtLine(lineNumber);
	if (foldingRegion !== null) {
		startLineNumber = foldingRegion.startLineNumber;
		// If current line is not the start of the current fold, go to top line of current fold. If not, go to parent fold
		if (lineNumber === startLineNumber) {
			let parentFoldingIdx = foldingRegion.parentIndex;
			if (parentFoldingIdx !== -1) {
				startLineNumber = foldingModel.regions.getStartLineNumber(parentFoldingIdx);
			} else {
				startLineNumber = null;
			}
		}
	}
	return startLineNumber;
}

/**
 * Get line to go to for previous fold at the same level of current line
 * @param lineNumber the current line number
 * @param foldingModel the folding model
 *
 * @return Previous fold start line
 */
export function getPreviousFoldLine(lineNumber: number, foldingModel: FoldingModel): number | null {
	let foldingRegion = foldingModel.getRegionAtLine(lineNumber);
	// If on the folding range start line, go to previous sibling.
	if (foldingRegion !== null && foldingRegion.startLineNumber === lineNumber) {
		// If current line is not the start of the current fold, go to top line of current fold. If not, go to previous fold.
		if (lineNumber !== foldingRegion.startLineNumber) {
			return foldingRegion.startLineNumber;
		} else {
			// Find min line number to stay within parent.
			let expectedParentIndex = foldingRegion.parentIndex;
			let minLineNumber = 0;
			if (expectedParentIndex !== -1) {
				minLineNumber = foldingModel.regions.getStartLineNumber(foldingRegion.parentIndex);
			}

			// Find fold at same level.
			while (foldingRegion !== null) {
				if (foldingRegion.regionIndex > 0) {
					foldingRegion = foldingModel.regions.toRegion(foldingRegion.regionIndex - 1);

					// Keep at same level.
					if (foldingRegion.startLineNumber <= minLineNumber) {
						return null;
					} else if (foldingRegion.parentIndex === expectedParentIndex) {
						return foldingRegion.startLineNumber;
					}
				} else {
					return null;
				}
			}
		}
	} else {
		// Go to last fold that's before the current line.
		if (foldingModel.regions.length > 0) {
			foldingRegion = foldingModel.regions.toRegion(foldingModel.regions.length - 1);
			while (foldingRegion !== null) {
				// Found fold before current line.
				if (foldingRegion.startLineNumber < lineNumber) {
					return foldingRegion.startLineNumber;
				}
				if (foldingRegion.regionIndex > 0) {
					foldingRegion = foldingModel.regions.toRegion(foldingRegion.regionIndex - 1);
				} else {
					foldingRegion = null;
				}
			}
		}
	}
	return null;
}

/**
 * Get line to go to next fold at the same level of current line
 * @param lineNumber the current line number
 * @param foldingModel the folding model
 *
 * @return Next fold start line
 */
export function getNextFoldLine(lineNumber: number, foldingModel: FoldingModel): number | null {
	let foldingRegion = foldingModel.getRegionAtLine(lineNumber);
	// If on the folding range start line, go to next sibling.
	if (foldingRegion !== null && foldingRegion.startLineNumber === lineNumber) {
		// Find max line number to stay within parent.
		let expectedParentIndex = foldingRegion.parentIndex;
		let maxLineNumber = 0;
		if (expectedParentIndex !== -1) {
			maxLineNumber = foldingModel.regions.getEndLineNumber(foldingRegion.parentIndex);
		} else if (foldingModel.regions.length === 0) {
			return null;
		} else {
			maxLineNumber = foldingModel.regions.getEndLineNumber(foldingModel.regions.length - 1);
		}

		// Find fold at same level.
		while (foldingRegion !== null) {
			if (foldingRegion.regionIndex < foldingModel.regions.length) {
				foldingRegion = foldingModel.regions.toRegion(foldingRegion.regionIndex + 1);

				// Keep at same level.
				if (foldingRegion.startLineNumber >= maxLineNumber) {
					return null;
				} else if (foldingRegion.parentIndex === expectedParentIndex) {
					return foldingRegion.startLineNumber;
				}
			} else {
				return null;
			}
		}
	} else {
		// Go to first fold that's after the current line.
		if (foldingModel.regions.length > 0) {
			foldingRegion = foldingModel.regions.toRegion(0);
			while (foldingRegion !== null) {
				// Found fold after current line.
				if (foldingRegion.startLineNumber > lineNumber) {
					return foldingRegion.startLineNumber;
				}
				if (foldingRegion.regionIndex < foldingModel.regions.length) {
					foldingRegion = foldingModel.regions.toRegion(foldingRegion.regionIndex + 1);
				} else {
					foldingRegion = null;
				}
			}
		}
	}
	return null;
}

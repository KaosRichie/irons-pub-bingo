'use strict';

/*
 * Minimal in-memory stand-ins for the Google Apps Script services that
 * docs/apps-script-store.gs uses, so the REAL script can be executed and tested
 * under Node (run-tests.js) without a Google account, a spreadsheet, or the game.
 *
 * Only behavior the store script relies on is modeled:
 *  - sheets are arrays of rows; getDataRange of an empty sheet is a 1x1 '' range
 *    (matching Apps Script); ranges pad missing cells with ''
 *  - formatting calls (setNumberFormat, setFontWeight, ...) are chainable no-ops
 */

class FakeRange
{
	constructor(sheet, row, col, numRows, numCols)
	{
		this.sheet = sheet;
		this.row = row;
		this.col = col;
		this.numRows = numRows;
		this.numCols = numCols;
	}

	getValues()
	{
		const out = [];
		for (let r = 0; r < this.numRows; r++)
		{
			const src = this.sheet.data[this.row - 1 + r] || [];
			const row = [];
			for (let c = 0; c < this.numCols; c++)
			{
				const v = src[this.col - 1 + c];
				row.push(v === undefined ? '' : v);
			}
			out.push(row);
		}
		return out;
	}

	setValues(values)
	{
		for (let r = 0; r < values.length; r++)
		{
			const target = this.sheet.rowAt(this.row + r);
			for (let c = 0; c < values[r].length; c++)
			{
				target[this.col - 1 + c] = values[r][c];
			}
		}
		return this;
	}

	setValue(value)
	{
		return this.setValues([[value]]);
	}

	getValue()
	{
		return this.getValues()[0][0];
	}

	getRow()
	{
		return this.row;
	}

	getColumn()
	{
		return this.col;
	}

	getNumRows()
	{
		return this.numRows;
	}

	getNumColumns()
	{
		return this.numCols;
	}

	getSheet()
	{
		return this.sheet;
	}
}

for (const noop of ['setNumberFormat', 'setFontWeight', 'setFontSize', 'setWrap',
	'setVerticalAlignment', 'setBackground', 'setFontColor', 'setDataValidation', 'setNote'])
{
	FakeRange.prototype[noop] = function ()
	{
		return this;
	};
}

class FakeSheet
{
	constructor(name)
	{
		this.name = name;
		this.data = [];
	}

	rowAt(row)
	{
		while (this.data.length < row)
		{
			this.data.push([]);
		}
		return this.data[row - 1];
	}

	appendRow(row)
	{
		this.data.push(row.slice());
		return this;
	}

	getRange(row, col, numRows, numCols)
	{
		return new FakeRange(this, row, col,
			numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
	}

	getDataRange()
	{
		// Every whole-tab read is a slow call in the real service; tests count them.
		FakeSheet.reads = (FakeSheet.reads || 0) + 1;
		let cols = 1;
		for (const row of this.data)
		{
			cols = Math.max(cols, row.length);
		}
		return new FakeRange(this, 1, 1, Math.max(1, this.data.length), cols);
	}

	getLastRow()
	{
		return this.data.length;
	}

	deleteRow(row)
	{
		this.data.splice(row - 1, 1);
		return this;
	}

	clear()
	{
		this.data = [];
		return this;
	}

	getName()
	{
		return this.name;
	}

	setFrozenRows()
	{
		return this;
	}

	hideSheet()
	{
		this.hidden = true;
		return this;
	}

	setColumnWidth()
	{
		return this;
	}

	protect()
	{
		return {
			setDescription()
			{
				return {
					setWarningOnly()
					{
					}
				};
			}
		};
	}

	insertImage(blob, column, row)
	{
		this.images = this.images || [];
		const image = {
			blob, column, row, width: 0, height: 0,
			setWidth(w) { this.width = w; return this; },
			setHeight(h) { this.height = h; return this; }
		};
		this.images.push(image);
		return image;
	}
}

class FakeSpreadsheet
{
	constructor()
	{
		this.sheets = new Map();
		this.active = null;
	}

	setActive(name, row, col)
	{
		this.active = { name, row, col };
	}

	getActiveSheet()
	{
		return this.active ? this.getSheetByName(this.active.name) : null;
	}

	getActiveRange()
	{
		if (!this.active)
		{
			return null;
		}
		const { row, col } = this.active;
		return { getRow: () => row, getColumn: () => col, getNumRows: () => 1 };
	}

	getSheetByName(name)
	{
		return this.sheets.get(name) || null;
	}

	insertSheet(name)
	{
		const sheet = new FakeSheet(name);
		this.sheets.set(name, sheet);
		return sheet;
	}

	getSheets()
	{
		return Array.from(this.sheets.values());
	}

	deleteSheet(sheet)
	{
		if (this.sheets.size <= 1)
		{
			throw new Error('Cannot delete the last sheet');
		}
		this.sheets.delete(sheet.getName());
	}
}

/** A fresh, isolated fake Google environment: one spreadsheet, one property store. */
function createEnvironment()
{
	const spreadsheet = new FakeSpreadsheet();
	const properties = new Map();
	const cache = new Map();
	const urlFetches = [];
	const urlFetchBlocked = { value: false };
	// The HTTP status every fetch answers with; tests set 429 to model rate limits.
	const urlFetchStatus = { value: 204 };
	return {
		spreadsheet,
		urlFetches,
		urlFetchBlocked,
		urlFetchStatus,
		globals: {
			SpreadsheetApp: {
				getActiveSpreadsheet: () => spreadsheet,
				newDataValidation: () =>
				{
					const builder = {
						requireValueInList: () => builder,
						setAllowInvalid: () => builder,
						build: () => ({})
					};
					return builder;
				},
				getUi: () => ({
					Button: { YES: 'YES', NO: 'NO' },
					ButtonSet: { YES_NO: 'YES_NO' },
					createMenu()
					{
						return { addItem() { return this; }, addToUi() {} };
					},
					alert()
					{
						// Confirmations always say yes in tests.
						return 'YES';
					}
				})
			},
			ContentService: {
				MimeType: { JSON: 'application/json' },
				createTextOutput(text)
				{
					return {
						_text: text,
						setMimeType()
						{
							return this;
						},
						getContent()
						{
							return this._text;
						}
					};
				}
			},
			CacheService: {
				getScriptCache: () => ({
					get: key => (cache.has(key) ? cache.get(key) : null),
					put: (key, value) =>
					{
						cache.set(key, String(value));
					},
					remove: key =>
					{
						cache.delete(key);
					}
				})
			},
			LockService: {
				getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} })
			},
			UrlFetchApp: {
				fetch(url, options)
				{
					if (urlFetchBlocked.value)
					{
						// Models a simple-trigger context, where Google refuses
						// external requests outright.
						throw new Error('UrlFetchApp is not available in this context');
					}
					urlFetches.push({ url: String(url), options });
					const code = urlFetchStatus.value;
					return { getResponseCode: () => code, getContentText: () => '' };
				}
			},
			HtmlService: {
				createHtmlOutput(html)
				{
					return { _html: html, setTitle() { return this; }, getContent() { return this._html; } };
				}
			},
			Utilities: {
				base64Decode: text => Array.from(Buffer.from(String(text), 'base64')),
				newBlob: (bytes, contentType, name) => ({ bytes, contentType, name }),
				DigestAlgorithm: { SHA_256: 'SHA_256' },
				Charset: { UTF_8: 'UTF_8' },
				getUuid: () => require('crypto').randomUUID(),
				computeDigest: (algorithm, text, charset) =>
					Array.from(require('crypto').createHash('sha256')
						.update(String(text), 'utf8').digest())
						.map(b => (b > 127 ? b - 256 : b))
			},
			PropertiesService: {
				getScriptProperties: () => ({
					getProperty: key => (properties.has(key) ? properties.get(key) : null),
					setProperty: (key, value) =>
					{
						properties.set(key, String(value));
					},
					deleteProperty: key =>
					{
						properties.delete(key);
					},
					deleteAllProperties: () =>
					{
						properties.clear();
					}
				})
			},
			console
		}
	};
}

module.exports = { createEnvironment, FakeSheet };

// Stand-ins for the Google services the store script uses, backed by plain memory.
//
// The Durable Object owns one of these per event: the "spreadsheet" is the event's data,
// kept in memory while the object is awake and written to Durable Object storage row by row
// after every request (see worker.js). The model matches store-tests/gas-shim.js, which the
// store script's test suite already runs against.
import { sha256 } from './sha256.js';

class Range
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
				row.push(v === undefined || v === null ? '' : v);
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
				target[this.col - 1 + c] = values[r][c] instanceof Date
					? values[r][c].toISOString() : values[r][c];
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

// Formatting has no meaning without a spreadsheet UI; the calls stay chainable no-ops.
for (const noop of ['setNumberFormat', 'setFontWeight', 'setFontSize', 'setWrap', 'setNote',
	'setVerticalAlignment', 'setBackground', 'setFontColor', 'setDataValidation',
	'setHorizontalAlignment', 'setFontStyle', 'setBorder', 'merge', 'clearNote'])
{
	Range.prototype[noop] = function ()
	{
		return this;
	};
}

export class Sheet
{
	constructor(name, data, hidden)
	{
		this.name = name;
		this.data = data || [];
		this.hidden = !!hidden;
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
		this.data.push(row.map(v => (v instanceof Date ? v.toISOString() : v)));
		return this;
	}

	getRange(row, col, numRows, numCols)
	{
		return new Range(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
	}

	getDataRange()
	{
		let cols = 1;
		for (const row of this.data)
		{
			cols = Math.max(cols, row.length);
		}
		return new Range(this, 1, 1, Math.max(1, this.data.length), cols);
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

	hideSheet()
	{
		this.hidden = true;
		return this;
	}

	setFrozenRows()
	{
		return this;
	}

	setColumnWidth()
	{
		return this;
	}

	protect()
	{
		return { setDescription: () => ({ setWarningOnly() {} }) };
	}

	insertImage()
	{
		return { setWidth() { return this; }, setHeight() { return this; } };
	}
}

export class Spreadsheet
{
	constructor()
	{
		this.sheets = new Map();
	}

	getSheetByName(name)
	{
		return this.sheets.get(name) || null;
	}

	insertSheet(name)
	{
		const sheet = new Sheet(name);
		this.sheets.set(name, sheet);
		return sheet;
	}

	getSheets()
	{
		return Array.from(this.sheets.values());
	}

	deleteSheet(sheet)
	{
		this.sheets.delete(sheet.getName());
	}

	getActiveSheet()
	{
		return null;
	}

	getActiveRange()
	{
		return null;
	}
}

/**
 * The service objects for loadStore(). Discord posts are queued (Workers can't make a
 * synchronous request) and sent after the reply; alerts from admin actions are collected so
 * the admin page can show them.
 */
export function createGoogle(spreadsheet, properties, cache)
{
	const outbox = [];
	const alerts = [];
	const output = content => ({
		_content: String(content),
		setMimeType() { return this; },
		setTitle() { return this; },
		addMetaTag() { return this; },
		setXFrameOptionsMode() { return this; },
		getContent() { return this._content; }
	});
	const google = {
		outbox,
		alerts,
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
				Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
				ButtonSet: { YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
				createMenu() { return { addItem() { return this; }, addToUi() {} }; },
				// The admin page asks for confirmation before it runs an action.
				alert(title, message)
				{
					alerts.push(message === undefined ? String(title) : String(title) + '\n' + String(message));
					return 'YES';
				},
				prompt() { return { getSelectedButton: () => 'CANCEL', getResponseText: () => '' }; }
			})
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
				}
			})
		},
		CacheService: {
			getScriptCache: () => ({
				get: key =>
				{
					const hit = cache.get(key);
					if (!hit || hit.expires < Date.now())
					{
						cache.delete(key);
						return null;
					}
					return hit.value;
				},
				put: (key, value, seconds) =>
				{
					cache.set(key, { value: String(value), expires: Date.now() + (seconds || 600) * 1000 });
				},
				remove: key =>
				{
					cache.delete(key);
				}
			})
		},
		// A Durable Object handles one request at a time, so the lock is always free.
		LockService: {
			getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {}, hasLock: () => true })
		},
		UrlFetchApp: {
			fetch(url, options)
			{
				outbox.push({ url: String(url), options: options || {} });
				return { getResponseCode: () => 204, getContentText: () => '' };
			}
		},
		ContentService: {
			MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
			createTextOutput: content => output(content)
		},
		HtmlService: {
			createHtmlOutput: html => output(html),
			XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
		},
		Utilities: {
			DigestAlgorithm: { SHA_256: 'SHA_256' },
			Charset: { UTF_8: 'UTF_8' },
			computeDigest: (algorithm, text) => Array.from(sha256(text)).map(b => (b > 127 ? b - 256 : b)),
			getUuid: () => crypto.randomUUID()
		},
		console
	};
	return google;
}

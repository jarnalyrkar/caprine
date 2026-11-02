// Slack-style emoji shortcode completion for the message composer.
// Typing `:` followed by at least two characters shows a list of matching emoji.
// Typing a complete shortcode like `:heart_eyes:` replaces it with the emoji right away.
// The emoji data and shortcodes come from `emoji-datasource`, the same source Signal Desktop and Slack use.

type RawEmoji = {
	unified: string;
	short_names: string[];
	sort_order: number;
	obsoleted_by?: string;
};

type EmojiEntry = {
	emoji: string;
	shortNames: string[];
	sortOrder: number;
};

type Match = {
	entry: EmojiEntry;
	shortName: string;
};

type Shortcode = {
	node: Text;
	start: number;
	end: number;
	query: string;
	isClosed: boolean;
};

const maxResults = 10;
const minQueryLength = 2;
const composerSelector = '[role=textbox][contenteditable=true]';

// Shortcode before the caret: must be at the start of the text or preceded by whitespace or an opening bracket,
// so that things like URLs (`https://`) and times (`10:30`) do not trigger completion.
const openShortcodeRegex = /(?:^|[\s([{])(:([\w+-]+))$/;
const closedShortcodeRegex = /(?:^|[\s([{])(:([\w+-]+):)$/;

let isEnabled = true;
let emojiList: EmojiEntry[] | undefined;
let emojiByShortName: Map<string, EmojiEntry> | undefined;

let popup: HTMLElement | undefined;
let matches: Match[] = [];
let selectedIndex = 0;
let activeQuery: string | undefined;

function unifiedToEmoji(unified: string): string {
	return String.fromCodePoint(...unified.split('-').map(codePoint => Number.parseInt(codePoint, 16)));
}

function loadEmojiData(): EmojiEntry[] {
	if (!emojiList) {
		const rawEmoji = require('emoji-datasource/emoji.json') as RawEmoji[];

		emojiList = rawEmoji
			.filter(emoji => !emoji.obsoleted_by)
			.map(emoji => ({
				emoji: unifiedToEmoji(emoji.unified),
				shortNames: emoji.short_names,
				sortOrder: emoji.sort_order,
			}))
			.sort((a, b) => a.sortOrder - b.sortOrder);

		emojiByShortName = new Map();
		for (const entry of emojiList) {
			for (const shortName of entry.shortNames) {
				emojiByShortName.set(shortName, entry);
			}
		}
	}

	return emojiList;
}

function getEmojiByShortName(shortName: string): EmojiEntry | undefined {
	loadEmojiData();
	return emojiByShortName!.get(shortName.toLowerCase());
}

// Lower is better
function scoreShortName(shortName: string, query: string): number | undefined {
	if (shortName === query) {
		return 0;
	}

	if (shortName.startsWith(query)) {
		return 1;
	}

	// Match at the start of a word, for example `eyes` in `heart_eyes`
	if (shortName.includes(`_${query}`) || shortName.includes(`-${query}`)) {
		return 2;
	}

	if (shortName.includes(query)) {
		return 3;
	}

	return undefined;
}

export function searchEmoji(query: string, limit = maxResults): Match[] {
	const normalizedQuery = query.toLowerCase();
	const results: Array<Match & {score: number}> = [];

	for (const entry of loadEmojiData()) {
		let best: {score: number; shortName: string} | undefined;

		for (const shortName of entry.shortNames) {
			const score = scoreShortName(shortName, normalizedQuery);
			if (score !== undefined && (!best || score < best.score)) {
				best = {score, shortName};
			}
		}

		if (best) {
			results.push({entry, ...best});
		}
	}

	// `emojiList` is already ordered by `sortOrder`, and `Array#sort` is stable,
	// so emoji with the same score keep their natural ordering.
	results.sort((a, b) => a.score - b.score);

	return results.slice(0, limit).map(({entry, shortName}) => ({entry, shortName}));
}

function getComposer(node: Node | undefined): HTMLElement | undefined {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest<HTMLElement>(composerSelector) ?? undefined;
}

function getShortcodeBeforeCaret(): Shortcode | undefined {
	const selection = window.getSelection();

	if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
		return undefined;
	}

	const {anchorNode, anchorOffset} = selection;

	if (!(anchorNode instanceof Text) || !getComposer(anchorNode)) {
		return undefined;
	}

	const textBeforeCaret = anchorNode.data.slice(0, anchorOffset);

	const closedMatch = closedShortcodeRegex.exec(textBeforeCaret);
	if (closedMatch) {
		return {
			node: anchorNode,
			start: anchorOffset - closedMatch[1].length,
			end: anchorOffset,
			query: closedMatch[2],
			isClosed: true,
		};
	}

	const openMatch = openShortcodeRegex.exec(textBeforeCaret);
	if (openMatch && openMatch[2].length >= minQueryLength) {
		return {
			node: anchorNode,
			start: anchorOffset - openMatch[1].length,
			end: anchorOffset,
			query: openMatch[2],
			isClosed: false,
		};
	}

	return undefined;
}

async function replaceShortcode(shortcode: Shortcode, text: string): Promise<void> {
	const selection = window.getSelection();

	if (!selection || !shortcode.node.isConnected) {
		return;
	}

	selection.setBaseAndExtent(shortcode.node, shortcode.start, shortcode.node, shortcode.end);

	// Messenger's editor (Lexical) only syncs its internal selection on the asynchronous `selectionchange` event,
	// so wait for it before inserting. Otherwise the emoji would be inserted at the old caret position.
	await new Promise(resolve => {
		setTimeout(resolve, 0);
	});

	// Bail out if the user changed the selection or text in the meantime
	if (
		selection.anchorNode !== shortcode.node
		|| selection.anchorOffset !== shortcode.start
		|| selection.focusNode !== shortcode.node
		|| selection.focusOffset !== shortcode.end
	) {
		return;
	}

	// Using `execCommand` (instead of mutating the DOM directly) goes through the browser's
	// regular `beforeinput`/`input` events, so Messenger's editor picks up the change
	// and the replacement can be undone with Undo.
	document.execCommand('insertText', false, text);
}

function closePopup(): void {
	popup?.remove();
	popup = undefined;
	matches = [];
	selectedIndex = 0;
	activeQuery = undefined;
}

function selectMatch(index: number): void {
	const match = matches[index];
	// Look up the shortcode again instead of reusing the one from when the list was rendered,
	// as Messenger's editor may have replaced the underlying text node since then.
	const shortcode = getShortcodeBeforeCaret();

	closePopup();

	if (match && shortcode && !shortcode.isClosed) {
		replaceShortcode(shortcode, `${match.entry.emoji} `);
	}
}

function updateSelectedItem(): void {
	if (!popup) {
		return;
	}

	for (const [index, item] of [...popup.children].entries()) {
		const isSelected = index === selectedIndex;
		item.setAttribute('aria-selected', String(isSelected));
		item.classList.toggle('caprine-emoji-completion-selected', isSelected);

		if (isSelected) {
			item.scrollIntoView({block: 'nearest'});
		}
	}
}

function positionPopup(element: HTMLElement, shortcode: Shortcode): void {
	const range = document.createRange();
	range.setStart(shortcode.node, shortcode.start);
	range.setEnd(shortcode.node, shortcode.end);

	let rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) {
		rect = getComposer(shortcode.node)?.getBoundingClientRect() ?? rect;
	}

	const margin = 8;
	const left = Math.max(margin, Math.min(rect.left, window.innerWidth - element.offsetWidth - margin));

	element.style.left = `${left}px`;
	// The composer is at the bottom of the window, so show the list above the text
	element.style.bottom = `${window.innerHeight - rect.top + margin}px`;
}

function renderPopup(shortcode: Shortcode): void {
	if (!popup) {
		popup = document.createElement('div');
		popup.id = 'caprine-emoji-completion';
		popup.setAttribute('role', 'listbox');
		popup.setAttribute('aria-label', 'Emoji suggestions');

		// Keep focus (and the caret) in the composer when clicking a suggestion
		popup.addEventListener('mousedown', event => {
			event.preventDefault();
		});

		document.body.append(popup);
	}

	const items = matches.map((match, index) => {
		const item = document.createElement('div');
		item.setAttribute('role', 'option');
		item.className = 'caprine-emoji-completion-item';

		const emoji = document.createElement('span');
		emoji.className = 'caprine-emoji-completion-emoji';
		emoji.textContent = match.entry.emoji;

		const name = document.createElement('span');
		name.className = 'caprine-emoji-completion-name';
		name.textContent = `:${match.shortName}:`;

		item.append(emoji, name);

		item.addEventListener('mousemove', () => {
			if (selectedIndex !== index) {
				selectedIndex = index;
				updateSelectedItem();
			}
		});

		item.addEventListener('click', () => {
			selectMatch(index);
		});

		return item;
	});

	popup.replaceChildren(...items);
	updateSelectedItem();
	positionPopup(popup, shortcode);
}

function update(isTyping: boolean): void {
	if (!isEnabled) {
		closePopup();
		return;
	}

	const shortcode = getShortcodeBeforeCaret();

	if (!shortcode) {
		closePopup();
		return;
	}

	if (shortcode.isClosed) {
		closePopup();

		// Only auto-replace right after the closing colon is typed, not when moving the caret around
		const entry = isTyping ? getEmojiByShortName(shortcode.query) : undefined;
		if (entry) {
			replaceShortcode(shortcode, entry.emoji);
		}

		return;
	}

	const previousQuery = activeQuery;
	const newMatches = searchEmoji(shortcode.query);

	if (newMatches.length === 0) {
		closePopup();
		return;
	}

	activeQuery = shortcode.query;

	if (previousQuery !== shortcode.query) {
		matches = newMatches;
		selectedIndex = 0;
	}

	renderPopup(shortcode);
}

function handleKeydown(event: KeyboardEvent): void {
	if (!popup || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
		return;
	}

	switch (event.key) {
		case 'ArrowDown': {
			selectedIndex = (selectedIndex + 1) % matches.length;
			updateSelectedItem();
			break;
		}

		case 'ArrowUp': {
			selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
			updateSelectedItem();
			break;
		}

		case 'Enter':
		case 'Tab': {
			if (event.shiftKey) {
				return;
			}

			selectMatch(selectedIndex);
			break;
		}

		case 'Escape': {
			closePopup();
			break;
		}

		default: {
			return;
		}
	}

	// Prevent Messenger from also handling the key, for example sending the message on Enter
	event.preventDefault();
	event.stopImmediatePropagation();
}

export function setEmojiCompletionEnabled(enabled: boolean): void {
	isEnabled = enabled;

	if (!enabled) {
		closePopup();
	}
}

export function initEmojiCompletion(): void {
	// Use the capture phase so our handlers run before Messenger's own handlers
	document.addEventListener('input', event => {
		if (getComposer(event.target as Node)) {
			update(true);
		}
	}, true);

	document.addEventListener('keydown', handleKeydown, true);

	document.addEventListener('selectionchange', () => {
		// Keep the list in sync when the caret moves, but don't open it just from moving the caret
		if (popup) {
			update(false);
		}
	});

	document.addEventListener('focusout', event => {
		if (popup && getComposer(event.target as Node)) {
			closePopup();
		}
	}, true);

	window.addEventListener('resize', closePopup);
}

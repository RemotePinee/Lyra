/**
 * The words inside a document, for a model that can only read words.
 *
 * Attaching a contract used to mean one of two things, both useless: before, the file's bytes were
 * decoded as UTF-8 and several thousand replacement characters went into the prompt; after the
 * first fix, nothing went at all and a notice said the contents could not be read. Neither is what
 * anybody attaches a contract for.
 *
 * The modern Office formats make this tractable — `.docx`, `.pptx` and `.xlsx` are zip archives of
 * XML, and the text is in there in plain sight. No conversion, no external binary, no service.
 *
 * What is *not* handled is said plainly rather than guessed at:
 *
 *   - `.doc`, `.xls`, `.ppt` — the pre-2007 binary formats. These are OLE compound files, a
 *     different thing entirely, and extracting text from one means implementing a filesystem. A
 *     wrong answer here is worse than none: half a contract, silently.
 *   - `.pdf` — has a text layer, but reaching it needs a real parser, and a scanned PDF has no text
 *     at all. Left for its own pass rather than half-done.
 *
 * The caller is told which case it got, so the person attaching the file finds out here rather than
 * from an answer that quietly ignored it.
 */

import { unzipSync, strFromU8 } from "fflate";

export interface ExtractedText {
	text: string;
	/** Roughly how much was in there, before any truncation. */
	fullLength: number;
	truncated: boolean;
}

/**
 * How much of one document may enter a prompt.
 *
 * A contract runs to a few thousand words and belongs in full. A five-hundred-page manual does not:
 * it would evict the rest of the conversation from the context window, and the person attaching it
 * almost always means "the part about X". Truncation is reported so the answer can say so.
 */
const MAX_CHARS = 120_000;

/** Extensions that are a zip underneath, whatever they are called. */
const ZIP_LIKE = new Set(["zip", "jar", "war", "ipa", "apk", "aar", "whl", "nupkg", "vsix", "epub", "xpi", "crx"]);

/** Every `<w:t>`, `<a:t>` or `<t>` run in an OOXML part, in document order. */
function textFromOoxml(xml: string): string {
	const out: string[] = [];
	/*
	 * Regex rather than an XML parser, and the shape of the format is why it holds: text lives in
	 * leaf elements whose names end in `:t` or are exactly `t`, and they never nest. Paragraph and
	 * row boundaries become newlines so the result reads as a document rather than a wall.
	 */
	const pattern = /<(?:[a-z]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-z]+:)?t>|<\/(?:w:p|a:p|w:tr)>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml))) {
		if (match[1] === undefined) {
			out.push("\n");
			continue;
		}
		out.push(unescapeXml(match[1]));
	}
	return out.join("");
}

function unescapeXml(raw: string): string {
	return raw
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

/** Collapse the runs of blank lines that paragraph boundaries leave behind. */
function tidy(text: string): string {
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function finish(text: string): ExtractedText {
	const tidied = tidy(text);
	return {
		text: tidied.length > MAX_CHARS ? tidied.slice(0, MAX_CHARS) : tidied,
		fullLength: tidied.length,
		truncated: tidied.length > MAX_CHARS,
	};
}

/** A Word document: the body, plus headers and footers, which carry parties and dates. */
export function textFromDocx(bytes: Uint8Array): ExtractedText {
	const zip = unzipSync(bytes);
	const parts = ["word/document.xml"];
	// Headers and footers, in the order they are numbered.
	for (const name of Object.keys(zip).sort()) {
		if (/^word\/(header|footer)\d*\.xml$/.test(name)) parts.push(name);
	}
	const text = parts
		.map((name) => (zip[name] ? textFromOoxml(strFromU8(zip[name]!)) : ""))
		.filter(Boolean)
		.join("\n\n");
	return finish(text);
}

/**
 * A deck: one block per slide, numbered, plus whatever is in the speaker notes.
 *
 * Numbered because a question about a deck is nearly always about a particular slide, and an
 * unlabelled run of bullet points gives the model no way to answer "what does slide 4 say".
 */
export function textFromPptx(bytes: Uint8Array): ExtractedText {
	const zip = unzipSync(bytes);
	const slides = Object.keys(zip)
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => slideNumber(a) - slideNumber(b));

	const blocks = slides.map((name) => {
		const body = textFromOoxml(strFromU8(zip[name]!));
		const notesName = `ppt/notesSlides/notesSlide${slideNumber(name)}.xml`;
		const notes = zip[notesName] ? textFromOoxml(strFromU8(zip[notesName]!)) : "";
		const header = `## 第 ${slideNumber(name)} 页`;
		return [header, tidy(body), notes.trim() ? `（备注）${tidy(notes)}` : ""].filter(Boolean).join("\n");
	});
	return finish(blocks.join("\n\n"));
}

function slideNumber(name: string): number {
	return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/**
 * A workbook, as one block per sheet.
 *
 * `xlsx` is already a dependency — it is what the spreadsheet viewer uses — so this is the one
 * format where the parsing is somebody else's problem. CSV per sheet rather than a grid: it is the
 * densest way to put a table in front of a model, and the one it reads most reliably.
 */
export async function textFromXlsx(bytes: Uint8Array): Promise<ExtractedText> {
	const { read, utils } = await import("xlsx");
	const book = read(bytes, { type: "array" });
	const blocks = book.SheetNames.map((name) => {
		const sheet = book.Sheets[name];
		if (!sheet) return "";
		const csv = utils.sheet_to_csv(sheet, { blankrows: false });
		return csv.trim() ? `## ${name}\n${csv.trim()}` : "";
	}).filter(Boolean);
	return finish(blocks.join("\n\n"));
}

/**
 * An archive, as the list of what is in it.
 *
 * Not the contents: a zip is arbitrarily large and arbitrarily nested, and unpacking one into a
 * prompt is how a context window disappears. The listing is what the question is nearly always
 * about — "what's in this jar", "did the build output what I expected" — and it is small.
 *
 * Sizes are included because they answer the second question people ask, and directories are left
 * out because the paths already say where everything sits.
 */
export function listArchive(bytes: Uint8Array): ExtractedText {
	const zip = unzipSync(bytes);
	const entries = Object.entries(zip)
		.filter(([name]) => !name.endsWith("/"))
		.sort(([a], [b]) => a.localeCompare(b));

	const lines = entries.map(([name, data]) => `${name}  (${formatBytes(data.length)})`);
	const header = `共 ${entries.length} 个文件`;
	return finish([header, ...lines].join("\n"));
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Which formats this module can read, keyed by extension. */
export const EXTRACTABLE = new Set([
	"docx", "pptx", "xlsx", "xlsm", "xlsb", "ods", "odt", "odp",
	"zip", "jar", "war", "ipa", "apk", "aar", "whl", "nupkg", "vsix", "epub", "xpi", "crx",
]);

/**
 * The text of a document, or null when the format is one nothing here can read.
 *
 * Null is a real answer and not a failure: it means "say so", which is what the caller does.
 */
export async function extractDocumentText(name: string, bytes: Uint8Array): Promise<ExtractedText | null> {
	const extension = name.toLowerCase().split(".").pop() ?? "";
	try {
		if (extension === "docx" || extension === "odt") return textFromDocx(bytes);
		if (extension === "pptx" || extension === "odp") return textFromPptx(bytes);
		if (extension === "xlsx" || extension === "xlsm" || extension === "xlsb" || extension === "ods") {
			return await textFromXlsx(bytes);
		}
		/*
		 * Zip-based bundles, listed rather than unpacked.
		 *
		 * `.jar`, `.apk`, `.whl`, `.vsix` and the rest are all zips wearing a different extension,
		 * and the question about one is nearly always what is inside — which the listing answers.
		 */
		if (ZIP_LIKE.has(extension)) return listArchive(bytes);
		return null;
	} catch {
		// A corrupt or unexpected file. Saying nothing beats putting garbage in the prompt, which is
		// exactly the failure this module exists to end.
		return null;
	}
}

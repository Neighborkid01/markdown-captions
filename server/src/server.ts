
import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentDiagnosticReportKind,
    type DocumentDiagnosticReport
} from 'vscode-languageserver/node';

import {
    Position,
    TextDocument
} from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!capabilities?.workspace?.configuration;
    hasWorkspaceFolderCapability = !!capabilities?.workspace?.workspaceFolders;
    hasDiagnosticRelatedInformationCapability =
		!!capabilities?.textDocument?.publishDiagnostics?.relatedInformation;

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            }
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

interface Settings {
    maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: Settings = { maxNumberOfProblems: 1000 };
let globalSettings: Settings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<Settings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <Settings>(
            (change.settings.markdownCaptionsLanguageServer || defaultSettings)
        );
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<Settings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'markdownCaptionsLanguageServer'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});


connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        } satisfies DocumentDiagnosticReport;
    } else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: []
        } satisfies DocumentDiagnosticReport;
    }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

// function validateFilenamesMatchImageTitles(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     const text = textDocument.getText();
//     // /filename - a bunch of stuff - title/
//     const pattern = /(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(.+\n.+\n\n)(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})\\/g;
//     let match: RegExpExecArray | null;

//     const diagnostics: Diagnostic[] = [];
//     while (
//         (match = pattern.exec(text)) &&
//         existingProblems + diagnostics.length < settings.maxNumberOfProblems
//     ) {
//         let filename = match[1];
//         let title = match[3];

//         if (filename === title) { continue; }

//         const filenameRange = {
//             start: textDocument.positionAt(match.index),
//             end: textDocument.positionAt(match.index + match[1].length)
//         };
//         const filenameDiagnostic: Diagnostic = {
//             severity: DiagnosticSeverity.Warning,
//             range: filenameRange,
//             message: 'This filename does not match the title of this image.',
//             source: 'Markdown Captions'
//         };
//         const titleRange = {
//             start: textDocument.positionAt(match.index + match[1].length + match[2].length),
//             end: textDocument.positionAt(match.index + match[0].length)
//         };
//         const titleDiagnostic: Diagnostic = {
//             severity: DiagnosticSeverity.Warning,
//             range: titleRange,
//             message: 'This image title does not match the filename.',
//             source: 'Markdown Captions'
//         };
//         if (hasDiagnosticRelatedInformationCapability) {
//             const relatedInformation = [
//                 {
//                     location: {
//                         uri: textDocument.uri,
//                         range: filenameRange,
//                     },
//                     message: `Filename: ${filename}`
//                 },
//                 {
//                     location: {
//                         uri: textDocument.uri,
//                         range: titleRange,
//                     },
//                     message: `Title: ${title}`
//                 },
//             ];
//             filenameDiagnostic.relatedInformation = relatedInformation;
//             titleDiagnostic.relatedInformation = relatedInformation;
//         }
//         diagnostics.push(filenameDiagnostic);
//         diagnostics.push(titleDiagnostic);
//     }
//     return diagnostics;
// }

// function validateFileHasCorrectSpacing(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     return [];
// }

// function validateFilenameDateMatchesCaptionDate(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     const text = textDocument.getText();
//     const pattern = /(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(\\\n)(.+)\\/g;
//     const titleDatePattern = /(\d{6})/i;
//     const captionDatePattern = /(.+)((?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec).?\s+\d{1,2}(?:st|nd|rd|th)?,?\s\d{2,4})/i;
//     let match: RegExpExecArray | null;

//     const diagnostics: Diagnostic[] = [];
//     while (
//         (match = pattern.exec(text)) &&
//         existingProblems + diagnostics.length < settings.maxNumberOfProblems
//     ) {
//         let title = match[1];
//         let caption = match[3];

//         let titleDateStr = title.match(titleDatePattern);
//         let captionDateStr = caption.match(captionDatePattern);
//         if (!titleDateStr || !captionDateStr) {
//             continue
//         }

//         const year: number = 2000 + Number(titleDateStr[1].substring(0, 2));
//         const month: number = -1 + Number(titleDateStr[1].substring(2, 4)); // Months are 0-indexed
//         const day: number = Number(titleDateStr[1].substring(4, 6));
//         const months = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
//         const expectedCaptionDate = `${months[month]} ${day}, ${year}`;

//         if (captionDateStr[2] === expectedCaptionDate) { continue; }

//         const start = match.index + match[1].length + match[2].length + captionDateStr[1].length;
//         const end = start + captionDateStr[2].length;
//         const diagnostic: Diagnostic = {
//             severity: DiagnosticSeverity.Warning,
//             range: {
//                 start: textDocument.positionAt(start),
//                 end: textDocument.positionAt(end)
//             },
//             message: `The date in the filename does not match the date in the caption or is not formatted correctly.\nExpected: ${expectedCaptionDate}\nFound:    ${captionDateStr[2]}`,
//             source: 'Markdown Captions'
//         };
//         diagnostics.push(diagnostic);
//     }
//     return diagnostics;
// }

// function validateCaptionDateIsFormattedCorrectly(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     return [];
// }

// function validateAbbreviationsArePunctuatedCorrectly(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     return [];
// }

// function validateAbbreviationOnlyUsedOnSecondRefference(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     return [];
// }

// function validateLinesThatShouldEndInBackslashesDo(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     return [];
// }

// function validateVIRINsAreValid(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     return [];
// }

// function validateUSStateNamesAreValid(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {

//     return [];
// }

type PositionAt = (offset: number) => Position;
type Keywords = string[];
type Caption = {
	imageTag: string;
	keywords: Keywords;
	title: string;
	description: string;
};
class CaptionBuilder {
	hasLeadingBlankLine: boolean = false;
    imageTag?: string;
    keywords?: Keywords;
    title?: string;
    description?: string;

	isEmpty(): boolean {
		return !this.imageTag &&
			!this.keywords &&
			!this.title &&
			!this.description;
	}

	firstMissingField(): string {
		if (!this.imageTag) { return 'image tag'; }
		if (!this.keywords) { return 'keywords'; }
		if (!this.title) { return 'image title'; }
		if (!this.description) { return 'description'; }
		return '';
	}

	getImageTagFromLine(
		text: string,
		diagnostics: Diagnostic[],
		maxNumberOfProblems: number,
		priorTextLength: number,
		positionAt: PositionAt,
	): string | undefined {
		const imageTagPattern = /^!\[\]\(\<.+>\)/g;
		let match = imageTagPattern.exec(text);
		if (match) { return text; }

		if (diagnostics.length < maxNumberOfProblems) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: positionAt(priorTextLength),
					end: positionAt(priorTextLength + text.length)
				},
				message: `Expected image tag resembling "![](<path/to/image.jpg>)", found "${text}".`,
				source: 'Markdown Captions'
			});
		}
	}

	getKeywordsFromLine(
		text: string,
		diagnostics: Diagnostic[],
		maxNumberOfProblems: number,
		priorTextLength: number,
		positionAt: PositionAt,
	): Keywords | undefined {
		const keywordsPattern = /^(Keywords: )(.+;)/g;
		let match = keywordsPattern.exec(text);
		if (match) {
			let keywords = match[2]
				.split(';')
				.map(k => k.trim())
				.filter(k => k.length > 0);
			return keywords;
		}

		if (diagnostics.length < maxNumberOfProblems) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: positionAt(priorTextLength),
					end: positionAt(priorTextLength + text.length)
				},
				message: `Expected line resembling "Keywords: Some; keywords;", found "${text}".`,
				source: 'Markdown Captions'
			});
		}
	}

	getTitleFromLine(
		text: string,
		diagnostics: Diagnostic[],
		maxNumberOfProblems: number,
		priorTextLength: number,
		positionAt: PositionAt,
	): string | undefined {
		const titlePattern = /^\d+-.+-\d+/g;
		let match = titlePattern.exec(text);
		if (match) { return text; }

		if (diagnostics.length < maxNumberOfProblems) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: positionAt(priorTextLength),
					end: positionAt(priorTextLength + text.length)
				},
				message: `Expected image title resembling "yymmdd-A-AB123-0000", found "${text}".`,
				source: 'Markdown Captions'
			});
		}
	}

	getFieldFromLine(
		text: string,
		diagnostics: Diagnostic[],
		maxNumberOfProblems: number,
		priorTextLength: number,
		positionAt: PositionAt,
	) {
		const blankLinePattern = /^\s*$/;
		let match = blankLinePattern.exec(text);
		if (match) {
			this.hasLeadingBlankLine = true;
			return;
		}

		if (!this.hasLeadingBlankLine) {
			this.hasLeadingBlankLine = true;
			if (diagnostics.length < maxNumberOfProblems) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: {
						start: positionAt(priorTextLength),
						end: positionAt(priorTextLength + text.length)
					},
					message: 'There should be at least one blank line between captions.',
					source: 'Markdown Captions'
				});
			}
		}
		if (!this.imageTag) {
			this.imageTag = this.getImageTagFromLine(text, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
			return;
		}
		if (!this.keywords) {
			this.keywords = this.getKeywordsFromLine(text, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
			return;
		}
		if (!this.title) {
			this.title = this.getTitleFromLine(text, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
			return;
		}
		if (!this.description) {
			this.description = text;
			return;
		}
	}

	build(): Caption | null {
		if (
			!this.imageTag ||
			!this.keywords ||
			!this.title ||
			!this.description
		) {
			return null;
		}

		return {
			imageTag: this.imageTag,
			keywords: this.keywords,
			title: this.title,
			description: this.description,
		};
	}
}

function validateHeadline(
    text: string,
    diagnostics: Diagnostic[],
    maxNumberOfProblems: number,
	priorTextLength: number,
    positionAt: PositionAt,
): string {
    const headlinePattern = /^(.+)(?<!\\)$/;

    const match = headlinePattern.exec(text);
    if (match && diagnostics.length < maxNumberOfProblems) {
        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAt(priorTextLength),
                end: positionAt(priorTextLength + text.length)
            },
            message: 'The headline should end in a backslash for pandoc to render propper spacing.',
            source: 'Markdown Captions'
        });
    }
    return text;
}

function validateByline(
    text: string,
    diagnostics: Diagnostic[],
    maxNumberOfProblems: number,
	priorTextLength: number,
    positionAt: PositionAt,
): string {
    const bylinePattern = /^By (.+)/;
    let match = bylinePattern.exec(text);
    if (match) {
		return text;
	}

	const blankLinePattern = /^\s*$/;
	match = blankLinePattern.exec(text);
	if (match) {
		if (diagnostics.length < maxNumberOfProblems) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: {
					start: positionAt(priorTextLength),
					end: positionAt(priorTextLength + text.length)
				},
				message: 'Expected byline to immediately follow the headline.',
				source: 'Markdown Captions'
			});
		}
		return '';
	}

	if (diagnostics.length < maxNumberOfProblems) {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: {
				start: positionAt(priorTextLength),
				end: positionAt(priorTextLength + text.length)
			},
			message: `Expected byline, found "${text}".`,
			source: 'Markdown Captions'
		});
	}
    return text;
}

function validateBaseKeywords(
    text: string,
    diagnostics: Diagnostic[],
    maxNumberOfProblems: number,
	priorTextLength: number,
    positionAt: PositionAt,
): Keywords | null {
	const blankLinePattern = /^\s*$/;
	let match = blankLinePattern.exec(text);
	if (match) { return null; }

    const keywordsPattern = /(Keywords: )(.+;)/g;
    match = keywordsPattern.exec(text);
	if (!match) {
		if (diagnostics.length < maxNumberOfProblems) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: positionAt(priorTextLength),
					end: positionAt(priorTextLength + text.length)
				},
				message: `Expected keywords, found "${text}".`,
				source: 'Markdown Captions'
			});
		}
		return null;
	}

	let keywords = match[2]
		.split(';')
		.map(k => k.trim())
		.filter(k => k.length > 0);
	if (keywords.length <= 6) {
		return keywords;
	}

	diagnostics.push({
		severity: DiagnosticSeverity.Error,
		range: {
			start: positionAt(priorTextLength + match[1].length),
			end: positionAt(priorTextLength + match[0].length)
		},
		message: `A maximum of 6 keywords is allowed. Found ${keywords.length} keywords.`,
		source: 'Markdown Captions'
	});
    return keywords;
}

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
    const settings = await getDocumentSettings(textDocument.uri);
    const maxNumberOfProblems = settings.maxNumberOfProblems;

    let diagnostics: Diagnostic[] = [];
    const text = textDocument.getText();
    const lines = text.split('\n');
	let priorTextLength = 0;

    const positionAt: PositionAt = offset => textDocument.positionAt(offset);

    let headline: string = '';
    let byline: string = '';
    let baseKeywords: Keywords | null = null;
	let captionBuilder = new CaptionBuilder();
	let caption: Caption | null = null;
    let captions: Caption[] = [];

    for (let line of lines) {
        if (headline === '') {
            headline = validateHeadline(line, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
			priorTextLength += line.length + 1;
			continue;
		}
		if (byline === '') {
			byline = validateByline(line, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
			priorTextLength += line.length + 1;
			continue;
		}
		if (baseKeywords === null) {
			baseKeywords = validateBaseKeywords(line, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
			priorTextLength += line.length + 1;
			continue;
		}
		captionBuilder.getFieldFromLine(line, diagnostics, maxNumberOfProblems, priorTextLength, positionAt);
		priorTextLength += line.length + 1;
		caption = captionBuilder.build();
		if (caption) {
			captions.push(caption);
			captionBuilder = new CaptionBuilder();
		}
    }

	if (!captionBuilder.isEmpty()) {
		let firstMissingField = captionBuilder.firstMissingField();
		let isAre =
			firstMissingField === 'description' ? 'is' : 'and all later fields are';
		let message =
			`Found incomplete caption. The ${firstMissingField} ${isAre} missing.`;
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: {
				start: positionAt(priorTextLength - lines[lines.length - 1].length - 1),
				end: positionAt(priorTextLength)
			},
			message,
			source: 'Markdown Captions'
		});
	}

	// TODO: Validate captions

    return diagnostics;
}

connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log('We received a file change event');
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

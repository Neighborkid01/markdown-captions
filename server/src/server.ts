
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
    hasDiagnosticRelatedInformationCapability = !!capabilities?.textDocument?.publishDiagnostics?.relatedInformation;

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

// function validateKeywords(
//     existingProblems: number,
//     settings: Settings,
//     textDocument: TextDocument
// ): Diagnostic[] {
//     const text = textDocument.getText();
//     const pattern = /(Keywords: )(.+;)/g;
//     let match: RegExpExecArray | null;

//     let baseKeywords = [];
//     const diagnostics: Diagnostic[] = [];
//     while (
//         (match = pattern.exec(text)) &&
//         existingProblems + diagnostics.length < settings.maxNumberOfProblems
//     ) {
//         let keywords = match[2]
//             .split(';')
//             .map(k => k.trim())
//             .filter(k => k.length > 0);
//         let keywordsCount = baseKeywords.length + keywords.length;

//         if (baseKeywords.length === 0) { baseKeywords = keywords; }
//         if (keywordsCount <= 6) { continue; }

//         let message =
//             `A maximum of 6 keywords is allowed. Found ${baseKeywords.length} base keywords and ${keywords.length} image-specific keyword${keywords.length == 1 ? "" : "s"}.`;
//         if (baseKeywords.length === keywordsCount) {
//             message = `A maximum of 6 keywords is allowed. Found ${keywordsCount} keywords.`;
//         }

//         const diagnostic: Diagnostic = {
//             severity: DiagnosticSeverity.Error,
//             range: {
//                 start: textDocument.positionAt(match.index + match[1].length),
//                 end: textDocument.positionAt(match.index + match[0].length)
//             },
//             message,
//             source: 'Markdown Captions'
//         };
//         diagnostics.push(diagnostic);
//     }
//     return diagnostics;
// }

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
type Keywords = {
    keywordString: string;
    keywords?: string[];
};
type Caption = {
    imageTag: string;
    title: string;
    keywords: Keywords;
    description: string;
}

function validateHeadline(
    text: string,
    previousNumberOfProblems: number,
    maxNumberOfProblems: number,
    positionAt: PositionAt
): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const headlinePattern = /^(.+)(?<!\\)$/;

    const match = headlinePattern.exec(text);
    if (match && previousNumberOfProblems +1 < maxNumberOfProblems) {
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAt(0),
                end: positionAt(text.length)
            },
            message: 'The headline should end in a backslash for pandoc to render propper spacing.',
            source: 'Markdown Captions'
        };
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
    const settings = await getDocumentSettings(textDocument.uri);
    const maxNumberOfProblems = settings.maxNumberOfProblems;

    let diagnostics: Diagnostic[] = [];
    const text = textDocument.getText();
    const lines = text.split('\n');

    const positionAt: PositionAt = offset => textDocument.positionAt(offset);

    let headline: string;
    let byLine: string;
    let baseKeywords: Keywords;
    let captions: Caption[] = [];

    let i = 0;
    for (let line of lines) {
        if (i === 0) {
            diagnostics = diagnostics.concat(validateHeadline(line, diagnostics.length, maxNumberOfProblems, positionAt));
            headline = line;
        // } else if (i === 1) {
        //     byLine = line;
        // } else if (i === 2) {
        //     baseKeywords = { keywordString: line };
        // } else if (i % 4 === 0) {
        //     let imageTag = line;
        //     let title = lines[i + 1];
        //     let keywords = { keywordString: lines[i + 2] };
        //     let description = lines[i + 3];
        //     captions.push({ imageTag, title, keywords, description });
        }
        i++;
    }
    // diagnostics = diagnostics.concat(validateKeywords(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateFilenamesMatchImageTitles(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateFileHasCorrectSpacing(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateFilenameDateMatchesCaptionDate(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateCaptionDateIsFormattedCorrectly(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateAbbreviationsArePunctuatedCorrectly(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateAbbreviationOnlyUsedOnSecondRefference(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateLinesThatShouldEndInBackslashesDo(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateVIRINsAreValid(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateUSStateNamesAreValid(diagnostics.length, settings, textDocument));

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

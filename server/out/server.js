"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
// Create a simple text document manager.
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!capabilities?.workspace?.configuration;
    hasWorkspaceFolderCapability = !!capabilities?.workspace?.workspaceFolders;
    hasDiagnosticRelatedInformationCapability = !!capabilities?.textDocument?.publishDiagnostics?.relatedInformation;
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
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
        connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});
// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings = { maxNumberOfProblems: 1000 };
let globalSettings = defaultSettings;
// Cache the settings of all open documents
const documentSettings = new Map();
connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    }
    else {
        globalSettings = ((change.settings.markdownCaptionsLanguageServer || defaultSettings));
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    connection.languages.diagnostics.refresh();
});
function getDocumentSettings(resource) {
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
            kind: node_1.DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        };
    }
    else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: node_1.DocumentDiagnosticReportKind.Full,
            items: []
        };
    }
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});
function validateKeywords(existingProblems, settings, textDocument) {
    const text = textDocument.getText();
    const pattern = /(Keywords: )(.+;)/g;
    let match;
    let baseKeywords = [];
    const diagnostics = [];
    while ((match = pattern.exec(text)) &&
        existingProblems + diagnostics.length < settings.maxNumberOfProblems) {
        let keywords = match[2]
            .split(';')
            .map(k => k.trim())
            .filter(k => k.length > 0);
        let keywordsCount = baseKeywords.length + keywords.length;
        if (baseKeywords.length === 0) {
            baseKeywords = keywords;
        }
        if (keywordsCount <= 6) {
            continue;
        }
        let message = `A maximum of 6 keywords is allowed. Found ${baseKeywords.length} base keywords and ${keywords.length} image-specific keyword${keywords.length == 1 ? "" : "s"}.`;
        if (baseKeywords.length === keywordsCount) {
            message = `A maximum of 6 keywords is allowed. Found ${keywordsCount} keywords.`;
        }
        const diagnostic = {
            severity: node_1.DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(match.index + match[1].length),
                end: textDocument.positionAt(match.index + match[0].length)
            },
            message,
            source: 'Markdown Captions'
        };
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}
function validateFilenamesMatchImageTitles(existingProblems, settings, textDocument) {
    const text = textDocument.getText();
    // /filename - a bunch of stuff - title/
    const pattern = /(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(.+\n.+\n\n)(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})\\/g;
    let match;
    const diagnostics = [];
    while ((match = pattern.exec(text)) &&
        existingProblems + diagnostics.length < settings.maxNumberOfProblems) {
        let filename = match[1];
        let title = match[3];
        if (filename === title) {
            continue;
        }
        const filenameRange = {
            start: textDocument.positionAt(match.index),
            end: textDocument.positionAt(match.index + match[1].length)
        };
        const filenameDiagnostic = {
            severity: node_1.DiagnosticSeverity.Warning,
            range: filenameRange,
            message: 'This filename does not match the title of this image.',
            source: 'Markdown Captions'
        };
        const titleRange = {
            start: textDocument.positionAt(match.index + match[1].length + match[2].length),
            end: textDocument.positionAt(match.index + match[0].length)
        };
        const titleDiagnostic = {
            severity: node_1.DiagnosticSeverity.Warning,
            range: titleRange,
            message: 'This image title does not match the filename.',
            source: 'Markdown Captions'
        };
        if (hasDiagnosticRelatedInformationCapability) {
            const relatedInformation = [
                {
                    location: {
                        uri: textDocument.uri,
                        range: filenameRange,
                    },
                    message: `Filename: ${filename}`
                },
                {
                    location: {
                        uri: textDocument.uri,
                        range: titleRange,
                    },
                    message: `Title: ${title}`
                },
            ];
            filenameDiagnostic.relatedInformation = relatedInformation;
            titleDiagnostic.relatedInformation = relatedInformation;
        }
        diagnostics.push(filenameDiagnostic);
        diagnostics.push(titleDiagnostic);
    }
    return diagnostics;
}
function validateFileHasCorrectSpacing(existingProblems, settings, textDocument) {
    return [];
}
function validateFilenameDateMatchesCaptionDate(existingProblems, settings, textDocument) {
    const text = textDocument.getText();
    const pattern = /(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(\\\n)(.+)\\/g;
    const titleDatePattern = /(\d{6})/i;
    const captionDatePattern = /(.+)((?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec).?\s+\d{1,2}(?:st|nd|rd|th)?,?\s\d{2,4})/i;
    let match;
    const diagnostics = [];
    while ((match = pattern.exec(text)) &&
        existingProblems + diagnostics.length < settings.maxNumberOfProblems) {
        let title = match[1];
        let caption = match[3];
        let titleDateStr = title.match(titleDatePattern);
        let captionDateStr = caption.match(captionDatePattern);
        if (!titleDateStr || !captionDateStr) {
            continue;
        }
        const year = 2000 + Number(titleDateStr[1].substring(0, 2));
        const month = -1 + Number(titleDateStr[1].substring(2, 4)); // Months are 0-indexed
        const day = Number(titleDateStr[1].substring(4, 6));
        const months = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
        const expectedCaptionDate = `${months[month]} ${day}, ${year}`;
        if (captionDateStr[2] === expectedCaptionDate) {
            continue;
        }
        const start = match.index + match[1].length + match[2].length + captionDateStr[1].length;
        const end = start + captionDateStr[2].length;
        const diagnostic = {
            severity: node_1.DiagnosticSeverity.Warning,
            range: {
                start: textDocument.positionAt(start),
                end: textDocument.positionAt(end)
            },
            message: `The date in the filename does not match the date in the caption or is not formatted correctly.\nExpected: ${expectedCaptionDate}\nFound:    ${captionDateStr[2]}`,
            source: 'Markdown Captions'
        };
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}
function validateCaptionDateIsFormattedCorrectly(existingProblems, settings, textDocument) {
    return [];
}
function validateAbbreviationsArePunctuatedCorrectly(existingProblems, settings, textDocument) {
    return [];
}
function validateAbbreviationOnlyUsedOnSecondRefference(existingProblems, settings, textDocument) {
    return [];
}
function validateLinesThatShouldEndInBackslashesDo(existingProblems, settings, textDocument) {
    return [];
}
function validateVIRINsAreValid(existingProblems, settings, textDocument) {
    return [];
}
function validateUSStateNamesAreValid(existingProblems, settings, textDocument) {
    return [];
}
async function validateTextDocument(textDocument) {
    const settings = await getDocumentSettings(textDocument.uri);
    let diagnostics = [];
    diagnostics = diagnostics.concat(validateKeywords(diagnostics.length, settings, textDocument));
    diagnostics = diagnostics.concat(validateFilenamesMatchImageTitles(diagnostics.length, settings, textDocument));
    // diagnostics = diagnostics.concat(validateFileHasCorrectSpacing(diagnostics.length, settings, textDocument));
    diagnostics = diagnostics.concat(validateFilenameDateMatchesCaptionDate(diagnostics.length, settings, textDocument));
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
//# sourceMappingURL=server.js.map
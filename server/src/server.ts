
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

class CaptionBuilder {
    index: number = 0;
    hasLeadingBlankLine: boolean = false;
    lines: string[] = [];
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
        if (diagnostics.length >= maxNumberOfProblems) { return; }

        const imageTagPattern = /^!\[\]\(\<.+>\)/g;
        let match = imageTagPattern.exec(text);
        if (match) { return text; }

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

    getKeywordsFromLine(
        text: string,
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        priorTextLength: number,
        positionAt: PositionAt,
    ): Keywords | undefined {
        if (diagnostics.length >= maxNumberOfProblems) { return; }

        const unfinishedKeywordsPattern = /^(Keywords:)(\s*)(.+;)?(\s*)(\S+(?<!;))$/g;
        let match = unfinishedKeywordsPattern.exec(text);
        if (match) {
            const matchesLength = match[1].length + match[2].length + (match[3]?.length || 0) + match[4].length;
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: positionAt(priorTextLength + matchesLength),
                    end: positionAt(priorTextLength + text.length)
                },
                message: `All keywords must end in a ";", found "${match[5]}" but expected "${match[5]};".`,
                source: 'Markdown Captions'
            });
        }

        const keywordsPattern = /^(Keywords:)(\s*)(.+;)?/g;
        match = keywordsPattern.exec(text);
        if (match) {
            let keywords = (match[3] || '')
                .split(';')
                .map(k => k.trim())
                .filter(k => k.length > 0);
            return keywords;
        }

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

    getTitleFromLine(
        text: string,
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        priorTextLength: number,
        positionAt: PositionAt,
    ): string | undefined {
        if (diagnostics.length >= maxNumberOfProblems) { return; }

        const titlePattern = /^\d+-.+-\d+/g;
        let match = titlePattern.exec(text);
        if (match) { return text; }

        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: positionAt(priorTextLength),
                end: positionAt(priorTextLength + text.length)
            },
            message: `Expected image title resembling "yymmdd-X-AB123-0000", found "${text}". (X can be any of A, F, G, M, N, or X)`,
            source: 'Markdown Captions'
        });
    }

    getFieldFromLine(
        text: string,
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        priorTextLength: number,
        positionAt: PositionAt,
    ) {
        if (diagnostics.length >= maxNumberOfProblems) { return; }

        this.index = this.index || priorTextLength;
        this.lines.push(text);

        const blankLinePattern = /^\s*$/;
        let match = blankLinePattern.exec(text);
        if (match) {
            this.hasLeadingBlankLine = true;
            return;
        }

        if (!this.hasLeadingBlankLine) {
            this.hasLeadingBlankLine = true;
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

        return new Caption(
            this.index,
            this.lines.join('\n'),
            this.imageTag,
            this.keywords,
            this.title,
            this.description,
        );
    }
}

class Caption {
    index: number;          // The index of the first line of the caption
    fullText: string;        // Full text of the caption split by line
    imageTag: string;       // The image tag line - "![](<path/to/image.jpg>)"
    keywords: Keywords;     // The keywords array - ["X", "Y", "Z"]
    title: string;          // The title line - "yymmdd-A-AB123-0000\"
    description: string;    // The description - "X person does Y on Z date."

    constructor(
        index: number,
        fullText: string,
        imageTag: string,
        keywords: Keywords,
        title: string,
        description: string
    ) {
        this.index = index;
        this.fullText = fullText;
        this.imageTag = imageTag;
        this.keywords = keywords;
        this.title = title;
        this.description = description;
    }

    validateImageTag(
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        positionAt: PositionAt,
    ) {
        if (diagnostics.length >= maxNumberOfProblems) { return; }
        let indexOfMatch: number;

        const correctFilenamePattern =
            /^(!\[\]\(\<.+\/)(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(\.jpg|\.mp4)\>\)\s*$/g;
        let match = correctFilenamePattern.exec(this.imageTag);
        if (match) { return; }

        const extraCrapOnTheEndPattern =
            /^(!\[\]\(\<.+\/)(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(\.jpg|\.mp4)(\>\)\s*)(.+)$/g;
        match = extraCrapOnTheEndPattern.exec(this.imageTag);
        if (match) {
            indexOfMatch = this.fullText.indexOf(`${match[4]}${match[5]}`);
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: positionAt(this.index + indexOfMatch + match[4].length),
                    end: positionAt(this.index + indexOfMatch + match[4].length + match[5].length)
                },
                message: `Found unexpected characters after image title "${match[5]}".`,
                source: 'Markdown Captions'
            });
            return;
        }

        const incorrectExtensionPattern =
            /^(!\[\]\(\<.+\/)(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(.+)\>\)\s*$/g;
        match = incorrectExtensionPattern.exec(this.imageTag);
        if (match) {
            indexOfMatch = this.fullText.indexOf(match[3]);
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + match[3].length)
                },
                message: `Expected image tag file extension to be .jpg or .mp4, found "${match[3]}".\nUsage of files with other extensions may result in unexpected outcomes.`,
                source: 'Markdown Captions'
            });
            return;
        }

        const incorrectFilenamePattern = /^(!\[\]\(\<.+\/)(.+)(\..+)\>\)\s*$/g;
        match = incorrectFilenamePattern.exec(this.imageTag);
        if (match) {
            indexOfMatch = this.fullText.indexOf(match[2]);
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + match[2].length)
                },
                message: `Expected filename to be of the format "yymmdd-X-AB123-0000", found "${match[2]}". (X can be any of A, F, G, M, N, or X)`,
                source: 'Markdown Captions'
            });
            return;
        }

        indexOfMatch = this.fullText.indexOf(this.imageTag);
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: positionAt(this.index + indexOfMatch),
                end: positionAt(this.index + indexOfMatch + this.imageTag.length)
            },
            message: `Unexpected error validating image tag.`,
            source: 'Markdown Captions'
        });
    }

    validateKeywords(
        baseKeywordsLength: number,
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        positionAt: PositionAt,
    ) {
        if (diagnostics.length >= maxNumberOfProblems) { return; }

        if (this.keywords.length == 0 || baseKeywordsLength + this.keywords.length <= 6) {
            return;
        }

        const indexOfFirstKeyword =
            this.fullText.indexOf(`${this.keywords[0]};`);
        const endIndexOfLastKeyword =
            this.fullText.indexOf(`${this.keywords[this.keywords.length - 1]};`) +
            this.keywords[this.keywords.length - 1].length + 1;
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: positionAt(this.index + indexOfFirstKeyword),
                end: positionAt(this.index + endIndexOfLastKeyword)
            },
            message: `A maximum of 6 total keywords is allowed. Found ${baseKeywordsLength} base keywords and ${this.keywords.length} image-specific keyword${this.keywords.length == 1 ? "" : "s"}.`,
            source: 'Markdown Captions'
        });
    }

    validateTitle(
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        positionAt: PositionAt,
    ) {
        if (diagnostics.length >= maxNumberOfProblems) { return; }
        let indexOfMatch: number;

        const titlePattern = /^(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})\\\s*$/g;
        let match = titlePattern.exec(this.title);
        if (match) { return; }

        const missingBackslashPattern = /^(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})((?<!\\)\s*)$/g;
        match = missingBackslashPattern.exec(this.title);
        if (match) {
            indexOfMatch = this.fullText.indexOf(`\n${match[1]}${match[2]}`) + match[1].length + 1;
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + match[2].length)
                },
                message: 'The title should end in a backslash for pandoc and markdown preview to render propper spacing.',
                source: 'Markdown Captions'
            });
            return;
        }

        indexOfMatch = this.fullText.indexOf(this.title);
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: positionAt(this.index + indexOfMatch),
                end: positionAt(this.index + indexOfMatch + this.title.length)
            },
            message: `Expected image title resembling "yymmdd-X-AB123-0000\\", found "${this.title}". (X can be any of A, F, G, M, N, or X)`,
            source: 'Markdown Captions'
        });
    }

    validateFilenamesMatchImageTitles(
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        positionAt: PositionAt,
    ) {
        if (diagnostics.length >= maxNumberOfProblems) { return; }
        let indexOfMatch: number;

        const filenamePattern =
            /^(!\[\]\(\<.+\/)(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})(\.jpg|\.mp4)\>\)\s*$/g;
        const titlePattern = /^(\d{6}-(?:A|F|G|M|N|X)-[A-Z0-9]{5}-\d{4})\\\s*$/g;
        const filenameMatch = filenamePattern.exec(this.imageTag);
        const titleMatch = titlePattern.exec(this.title);

        if (!filenameMatch) {
            indexOfMatch = this.fullText.indexOf(this.imageTag);
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + this.imageTag.length)
                },
                message: `Unexpected error validating image tag.`,
                source: 'Markdown Captions'
            });
            return;
        }
        if (!titleMatch) {
            indexOfMatch = this.fullText.indexOf(this.title);
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + this.title.length)
                },
                message: `Unexpected error validating image title.`,
                source: 'Markdown Captions'
            });
            return;
        }

        const filename = filenameMatch[2];
        const title = titleMatch[1];
        if (filename === title) { return; }

        const indexOfFilenameMatch = this.fullText.indexOf(filename);
        const indexOfTitleMatch = this.fullText.indexOf(title);
        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAt(this.index + indexOfFilenameMatch),
                end: positionAt(this.index + indexOfFilenameMatch + filename.length)
            },
            message: `This filename does not match the title of this image.\nFilename: ${filename}\nTitle:    ${title}`,
            source: 'Markdown Captions'
        });
        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAt(this.index + indexOfTitleMatch),
                end: positionAt(this.index + indexOfTitleMatch + title.length)
            },
            message: `This image title does not match the filename.\nFilename: ${filename}\nTitle:    ${title}`,
            source: 'Markdown Captions'
        });
    }

    validateFilenameDateMatchesCaptionDate(
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        positionAt: PositionAt,
    ) {
        if (diagnostics.length >= maxNumberOfProblems) { return; }
        let indexOfMatch: number;

        const titleDatePattern = /(\d{6})/i;
        const captionDatePattern = /(.+)((?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec).?\s+\d{1,2}(?:st|nd|rd|th)?,?\s\d{2,4})/i;
        const titleDateMatch = this.title.match(titleDatePattern);
        const captionDateMatch = this.description.match(captionDatePattern);

        if (!titleDateMatch) {
            indexOfMatch = this.fullText.indexOf(this.title);
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + this.title.length)
                },
                message: `Unexpected error parsing date from image title.`,
                source: 'Markdown Captions'
            });
            return;
        }
        if (!captionDateMatch) {
            indexOfMatch = this.fullText.indexOf(this.description);
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: positionAt(this.index + indexOfMatch),
                    end: positionAt(this.index + indexOfMatch + this.description.length)
                },
                message: `Cound not find date in caption. Expected date resembling "Jan. 1, 2000".`,
                source: 'Markdown Captions'
            });
            return;
        }

        const year: number = 2000 + Number(titleDateMatch[1].substring(0, 2));
        const month: number = -1 + Number(titleDateMatch[1].substring(2, 4)); // Months are 0-indexed
        const day: number = Number(titleDateMatch[1].substring(4, 6));
        const months = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
        const expectedCaptionDate = `${months[month]} ${day}, ${year}`;

        if (captionDateMatch[2] === expectedCaptionDate) { return; }

        indexOfMatch = this.fullText.indexOf(captionDateMatch[2]);
        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAt(this.index + indexOfMatch),
                end: positionAt(this.index + indexOfMatch + captionDateMatch[2].length)
            },
            message: `The date in the filename does not match the date in the caption or is not formatted correctly.\nExpected: ${expectedCaptionDate}\nFound:    ${captionDateMatch[2]}`,
            source: 'Markdown Captions'
        };
        diagnostics.push(diagnostic);
    }

    validate(
        baseKeywordsLength: number,
        diagnostics: Diagnostic[],
        maxNumberOfProblems: number,
        positionAt: PositionAt,
    ) {
        const diagnosticsLength = diagnostics.length;
        this.validateImageTag(diagnostics, maxNumberOfProblems, positionAt);
        this.validateKeywords(baseKeywordsLength, diagnostics, maxNumberOfProblems, positionAt);
        this.validateTitle(diagnostics, maxNumberOfProblems, positionAt);

        if (diagnostics.length > diagnosticsLength) { return; }
        this.validateFilenamesMatchImageTitles(diagnostics, maxNumberOfProblems, positionAt);
        this.validateFilenameDateMatchesCaptionDate(diagnostics, maxNumberOfProblems, positionAt);
    }
};

function validateHeadline(
    text: string,
    diagnostics: Diagnostic[],
    maxNumberOfProblems: number,
    priorTextLength: number,
    positionAt: PositionAt,
): string {
    if (diagnostics.length >= maxNumberOfProblems) { return text; }

    const headlinePattern = /^(.+)(?<!\\)$/;
    const match = headlinePattern.exec(text);
    if (match) {
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
    if (diagnostics.length >= maxNumberOfProblems) { return ''; }

    const bylinePattern = /^By (.+)/;
    let match = bylinePattern.exec(text);
    if (match) {
        return text;
    }

    const blankLinePattern = /^\s*$/;
    match = blankLinePattern.exec(text);
    if (match) {
        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAt(priorTextLength),
                end: positionAt(priorTextLength + text.length)
            },
            message: 'Expected byline to immediately follow the headline.',
            source: 'Markdown Captions'
        });
        return '';
    }

    diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
            start: positionAt(priorTextLength),
            end: positionAt(priorTextLength + text.length)
        },
        message: `Expected byline, found "${text}".`,
        source: 'Markdown Captions'
    });
    return text;
}

function validateBaseKeywords(
    text: string,
    diagnostics: Diagnostic[],
    maxNumberOfProblems: number,
    priorTextLength: number,
    positionAt: PositionAt,
): Keywords | null {
    if (diagnostics.length >= maxNumberOfProblems) { return null; }

    const blankLinePattern = /^\s*$/;
    let match = blankLinePattern.exec(text);
    if (match) { return null; }

    const keywordsPattern = /^(Keywords:)(\s*)(.+;)?/g;
    match = keywordsPattern.exec(text);
    if (!match) {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: positionAt(priorTextLength),
                end: positionAt(priorTextLength + text.length)
            },
            message: `Expected keywords, found "${text}".`,
            source: 'Markdown Captions'
        });
        return null;
    }

    let keywords = (match[3] || '')
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
        if (diagnostics.length < maxNumberOfProblems) {
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
    }

    const baseKeywordsLength = baseKeywords?.length || 0;
    for (caption of captions) {
        caption.validate(baseKeywordsLength, diagnostics, maxNumberOfProblems, positionAt);
    }

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

# Score

The **Score** dock tab engraves the active clip with Verovio. The panel prints and saves a PDF, and the **File** menu exports the active clip as MusicXML or compressed MusicXML (`.mxl`) and imports both. The engraving is derived from the clip; see [Notation is derived](architecture.md#notation-is-derived-never-authored) for how.

## Engrave the active clip

Select the **Score** dock tab. The first open loads the engraver, so it can take longer than later opens. The panel then shows the engraved notes as SVG, and the page indicator reads `1 / N`, where N is the number of pages.

## Add annotations

Annotations are drawn on the engraving. Focus the score note navigator and press the context-menu key to open the annotation palette.

Choose a dynamic in the palette, for example **f**. The engraving is re-rendered and gains the dynamic mark.

Click **Annotate** in the score toolbar to switch annotate mode off. The palette closes.

## Print

Click **Print** in the score toolbar once engraving has finished. The browser's print dialog receives one page per engraved page, each holding the engraved SVG, under a page-size rule for the printout.

## Save a PDF

Click **PDF**. The download is a PDF with the same number of pages that **Print** produces, and each page is footed `Page n / N`.

## Export MusicXML

1. Select the clip to export.
2. Open **File**.
3. Choose **Export clip as MusicXML…** for a plain `.musicxml` file, or **Export clip as compressed MusicXML (.mxl)…** for an `.mxl` archive.

The plain file is a `score-partwise` document with one pitched note per note in the clip. The `.mxl` archive stores `mimetype` first and uncompressed, then `META-INF/container.xml` pointing at the score.

## Import MusicXML

1. Open **File** and choose **Import MusicXML…**.
2. If the open project has unsaved changes, confirm the prompt that discards them. The import replaces the open project.
3. Choose a `.musicxml` or `.mxl` file.

The notes come back with the same pitches, lengths and relative timing.

Related: [Files and formats](files-and-formats.md) for the other import and export formats, and [keyboard shortcuts](shortcuts.md) for the score keys.

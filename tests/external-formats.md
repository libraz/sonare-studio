# External-format release gate

`yarn test:external-formats` runs the bounded archive/parser fuzz corpus, format
goldens and pinned schema validation used by `yarn verify`.

- MusicXML validation downloads the W3C MusicXML 4.0 release archive and checks
  its SHA-256 before running both XSD and DTD validation with `xmllint --nonet`.
- DAWproject validation downloads `Project.xsd`, `MetaData.xsd` and the
  format's reference project from a pinned upstream revision and verifies their
  SHA-256 values.
- The fuzz corpus never creates an input larger than 256 KiB and exercises
  `.szd`, browser backup, DAWproject, SMF and MusicXML parsers.

Optional installed-application smoke tests use the same gate:

```sh
NOTATION_CLI_BIN=/path/to/notation-cli \
DAWPROJECT_APP_FIXTURE=/path/to/application-export.dawproject \
yarn test:external-formats
```

The notation CLI check converts the current MusicXML fixture with
`<cli> -o <output> <input>`, revalidates the result and imports it into Sonare.
The fixture check performs a semantic Sonare import/export/reimport round trip
on a DAWproject file exported by a desktop DAW. These checks are reported as skipped when their inputs are absent;
release candidates intended for external interoperability should provide them.

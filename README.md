# GBIF Map Search

Static web app to preview [GBIF](https://www.gbif.org/) occurrence data for a map area without downloading individual records.

Draw a bounding box on the Mapbox map, drop a GeoJSON file, and query the GBIF Occurrence Search API for facet summaries: total count, species, datasets, publishers, years, and basis of record. Everything runs in the browser.

## API reference

- [GBIF Occurrence API](https://techdocs.gbif.org/en/openapi/v1/occurrence)

## Wikipedia enrichment

Species results are optionally enriched with English Wikipedia article links.
Resolution matches GBIF taxon IDs against Wikidata (legacy `P846` and newer
`P14607`), falling back to a batched scientific-name lookup on the Wikipedia
API that only accepts verified articles (redirects included).

Wikidata and Wikipedia are secondary services. When they are unavailable,
rate-limited, or have no match for a taxon, the GBIF inventory is unaffected
and that species simply has no link. The on-screen table keeps its `Name |
Count` layout (linked species names open Wikipedia in a new tab); the XLSX
Species sheet gains a `Wikipedia` column that is empty when no verified
article was found.

## Species grouping and cards

The Species tab groups results by kingdom (from the GBIF species lookup),
and Animalia further splits into class subgroups such as Aves or Mammalia.
Group headers only appear when the current filter leaves a species in that
group.

Every species row carries a card: on pointer devices it shows on hover, on
touch devices on tap. The card follows one pattern, filled by Wikipedia
first with GBIF covering what Wikipedia lacks: the image slot uses the
Wikipedia thumbnail when present, otherwise an occurrence photo from the
GBIF species media API fetched the first time that card opens; below sit the
name, the Wikipedia short description when available, the classification
line (kingdom > phylum > class > order > family > genus, plus a child-taxon
count, all from the same GBIF species lookup the table already uses), and
links to the Wikipedia article, the Wikidata item, and the GBIF taxon page
(`gbif.org/taxon/{key}`, one per species). A taxon with no English article
can still match a Wikidata item, which the Wikidata resolution keeps even
without a sitelink. All enrichment stays best-effort: any failure simply
leaves that card slot empty. The XLSX Species sheet includes `Kingdom` and
`Class` columns.

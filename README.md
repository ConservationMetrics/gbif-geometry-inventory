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

Species with a Wikipedia thumbnail or short description carry a card: on
pointer devices it shows on hover, on touch devices on tap. The card
displays the article thumbnail and its short description, plus a link to the
article. A species whose article has neither image nor description keeps
its inline link but no card. Thumbnails and descriptions come from one extra
batched Wikipedia request and are skipped entirely when Wikipedia is
unavailable. The XLSX Species sheet includes `Kingdom` and `Class` columns.

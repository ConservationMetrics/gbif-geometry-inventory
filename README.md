# GBIF Geometry Inventory

Static web app to preview [GBIF](https://www.gbif.org/) occurrence data for a map area without downloading individual records.

Draw a bounding box on the Mapbox map, drop a GeoJSON file, and query the GBIF Occurrence Search API for facet summaries: total count, species, datasets, publishers, years, and basis of record. All logic runs in the browser — no backend required.

## Troubleshooting

If a query fails, the status line below the results table explains why. Common cases:

- **Could not reach GBIF** — network issue, or the geometry is too complex for a browser GET request (URL too long). Try drawing a simple bounding box instead of a detailed polygon.
- **Results use the bounding box** — the uploaded polygon was automatically simplified to its bounding box so the query could fit in a browser URL.
- **GBIF could not parse the geometry** — the GeoJSON may be invalid or not in WGS84 (EPSG:4326).

## API reference

- [GBIF Occurrence API](https://techdocs.gbif.org/en/openapi/v1/occurrence)

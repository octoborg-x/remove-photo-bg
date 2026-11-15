# images-test

The 64 raw eval images from `eval/manifest.json`, downloaded by
`scripts/eval/download-images-test.py`. Files are the untouched source
renditions (same bytes as `eval/images/`), named by eval id.

Images the shipped model **fails** on carry an `error-` prefix, so a directory
listing separates what worked from what did not:

```
accessory-01.JPG            # worked
error-accessory-07.jpg      # failed
```

The `error-` set is the 8 eval images recorded as failures in
`artifacts/failed-inferences/manifest.json` — the empty / near-empty /
partial-subject outputs behind the "8/64" finding in `EVALUATION.md`:

| file | eval id | failure |
|---|---|---|
| `error-hair-fur-07.jpg` | hair-fur-07 | empty output |
| `error-hair-fur-08.jpg` | hair-fur-08 | empty output |
| `error-complex-bg-05.jpg` | complex-bg-05 | empty output |
| `error-thin-structure-04.jpg` | thin-structure-04 | empty output |
| `error-complex-bg-07.jpg` | complex-bg-07 | near-empty output |
| `error-accessory-07.jpg` | accessory-07 | partial subject removal |
| `error-hair-fur-06.jpg` | hair-fur-06 | partial subject removal |
| `error-glass-transparent-06.jpg` | glass-transparent-06 | partial subject removal |

`index.json` lists every file with its id, dimensions, byte size, SHA-256,
source URL and licence, and the `failed` flag that drives the prefix.

Regenerate (idempotent — existing files are kept):

```sh
python3 scripts/eval/download-images-test.py
```

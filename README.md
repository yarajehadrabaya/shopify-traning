# Search Synonyms Documentation

## Goal
Improve search results when shoppers use different words for the same item.

## Work Done
- Created **20+ synonym groups** in the Search & Discovery app.
- Each group contains bidirectional synonyms (e.g., *Cap ↔ Hat*).
- Tested **30 queries** before and after to confirm improvements.

## Example Synonym Groups
| Group Title | Synonyms                     |
|-------------|------------------------------|
| Hat         | hat, cap, headwear           |
| Sneakers    | sneakers, trainers, running shoes |
| Pants       | pants, trousers, slacks      |
| T-Shirt     | t-shirt, tee, top            |
| Jacket      | jacket, coat, outerwear      |

## Testing
- Verified that queries like *cap* also return **hats**.
- Reduced zero-result searches for common alternative terms.
- At least 5 active synonym groups confirmed working.

## Acceptance Criteria
✔ Synonym groups created and active  
✔ Queries return relevant results  
✔ Avoid zero results without clear reason  

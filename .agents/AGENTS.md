# Rule: WordPress REST API & Topic Cluster Audits

- Always treat subpaths like `tino.vn/blog/` as WordPress sites with an active WP-JSON REST API at `https://tino.vn/blog/wp-json/wp/v2/`.
- Never assume `tino.vn/blog` is a Next.js or static site.
- When performing SEO audits, content strategy analysis, or topic cluster linkage mapping:
  - For URLs: Always run `wp_seo_check.py --url <URL>` and `wp_seo_check.py --cluster --url <URL>`.
  - For pasted drafts/text: Extract keywords, search WordPress REST API for related categories, run `wp_seo_check.py --cluster --category-id <ID>`, and perform two-way internal link recommendations (existing articles linking to draft, and draft linking to existing articles).
- Never trigger GSC/GA4 database queries when the user is discussing blog articles, topic clusters, page audits, or linking structures, unless they specifically ask for analytics traffic metrics (visits, clicks, impressions).

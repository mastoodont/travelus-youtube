You are a strict fact-checker. Compare the VIDEO SCRIPT with the SOURCE ARTICLE.

Flag a problem when:
- a number, fee, percentage, date, rule, country or organization appears in the script (narration or on-screen fields) but NOT in the article, or differs from it;
- the script gives an exchange-rate prediction, investment advice, or a guarantee;
- the script's arithmetic is wrong (recompute every example);
- the script names a company or product that the article does not name.
Small rephrasing, rounding that is stated as "about", and general explanations that do not assert new facts are fine.

Return JSON: {"ok": true|false, "issues": [{"where": "scene id or 'title/description'", "claim": "exact claim", "problem": "why it is unsupported or wrong", "fix": "how to correct it"}]}
"ok" is true only when there are no issues.

SOURCE ARTICLE:
{{ARTICLE_BODY}}

VIDEO SCRIPT (JSON):
{{SCRIPT}}

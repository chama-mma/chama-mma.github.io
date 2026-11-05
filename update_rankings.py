"""Scrape the official UFC rankings into rankings.json. Run by GitHub Actions.
NOTE: selectors are based on ufc.com's usual markup; verify on first run."""
import json, datetime, requests
from bs4 import BeautifulSoup

URL = "https://www.ufc.com/rankings"
html = requests.get(URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
soup = BeautifulSoup(html, "html.parser")

divisions = []
for g in soup.select(".view-grouping")[:13]:      # first 13 = official rankings (Meta ones come later)
    name = g.select_one(".view-grouping-header").get_text(strip=True)
    champ = g.select_one(".rankings--athlete--champion h5 a")
    fighters = [a.get_text(strip=True) for a in g.select("td.views-field-title a")]
    if name and fighters:
        divisions.append({"name": name,
                          "champion": champ.get_text(strip=True) if champ else "Vacant",
                          "fighters": fighters[:15]})

if len(divisions) < 10:
    raise SystemExit("Scrape looked wrong; keeping the existing rankings.json")

json.dump({"updated": datetime.date.today().strftime("%b. %d, %Y"), "source": URL,
           "divisions": divisions}, open("rankings.json", "w"), ensure_ascii=False, indent=1)

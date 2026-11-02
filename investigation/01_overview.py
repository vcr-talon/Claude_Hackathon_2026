"""IFCファイルの全体像（ヘッダ・型別件数）を読み取り専用で確認する。"""
import sys
from collections import Counter
from pathlib import Path

import ifcopenshell

sys.stdout.reconfigure(encoding="utf-8")
IFC_PATH = Path(__file__).resolve().parent.parent / "hackathon_model.ifc"

f = ifcopenshell.open(str(IFC_PATH))
print("file:", IFC_PATH, f"{IFC_PATH.stat().st_size / 1e6:.1f} MB")
print("schema:", f.schema)
h = f.header
print("file_name:", h.file_name.name, "|", h.file_name.time_stamp)
print("originating_system:", h.file_name.originating_system)
print("preprocessor:", h.file_name.preprocessor_version)
print("description:", h.file_description.description)

for app in f.by_type("IfcApplication"):
    print("app:", app.ApplicationFullName, app.Version, app.ApplicationIdentifier)
for proj in f.by_type("IfcProject"):
    print("project:", proj.Name, proj.LongName)

counts = Counter(e.is_a() for e in f)
print("\n--- IfcProduct subtypes ---")
for t, n in counts.most_common():
    if f.by_type(t) and f.by_type(t)[0].is_a("IfcProduct"):
        print(f"{t:40s}{n}")
print("\n--- top 60 entity types ---")
for t, n in counts.most_common(60):
    print(f"{t:40s}{n}")

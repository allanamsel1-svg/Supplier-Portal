# Translation Key Plan — EN / 中文 Factory Portal

> **Status: AWAITING APPROVAL.** No application files will be changed until you approve this plan.
> This document is a planning artifact only (delete it any time).

## 1. Scope — pages that get the toggle

| File | What it is | How text is rendered |
|------|-----------|----------------------|
| `index.html` | Main factory portal (login + 9 tabs) | Mix of **static HTML** (lines 234–720) and **JS-generated `innerHTML`** (lines 721–4755) |
| `artwork-factory-review.html` | Factory artwork approval (token link) | Almost entirely **JS-generated** |
| `audit-report-upload.html` | Factory audit report upload (token link) | Almost entirely **JS-generated** |
| `factory-inspection-confirm.html` | Factory inspection readiness confirm (token link) | Almost entirely **JS-generated** |

**Explicitly NOT touched:** every admin/tenant/designer/intel page (admin.html, setup.html, skus.html, scanner.html, factory-detail.html, projections.html, financials.html, compliance-rules.html, roadmap.html, intelligence_hub.html, inspections.html, artwork-admin.html, all `tenant-*.html`, `designer-*.html`, and all "TBG Retail Intelligence" pages such as brand_watch, retailer_intel, shop_outs, social_trends, trade_intelligence, intel_*, mercury, zoom, communications, factory_prospects, factory-audits, logic_log, news_editorial, online_catalog).

---

## 2. Approach (no layout/logic/feature changes — text swap only)

1. **`translations.js`** — a new file holding `I18N = { en: {...}, zh: {...} }` plus a `t(key, vars)` helper and an `applyTranslations()` function. Loaded via `<script src="translations.js"></script>` at the top of each of the 4 pages.
2. **Static HTML** gets `data-i18n="key"` (for text), `data-i18n-ph="key"` (for placeholders), `data-i18n-aria="key"` (for aria-labels). `applyTranslations()` walks these and swaps text — **no DOM moved, no elements added/removed, no styling changed.**
3. **JS-generated strings** get wrapped in `t('key')` / `t('key',{vars})` in place of the English literals. Behaviour is identical; only the source of the string changes.
4. **Toggle button** added to the existing header (`.topbar-r` on index.html; the `.brand`/card top-right on the token pages), styled to match the existing controls exactly (same font-size, color, border, padding as the adjacent `signout-btn` / brand text). Clicking flips EN ⇄ 中文.
5. **Persistence:** selected language saved to `localStorage` under key `portal_lang` (values `"en"` / `"zh"`); read on page load before first render. Default = `en`.
6. **Dynamic panes:** when the user toggles language, `applyTranslations()` re-runs for static text, and any currently-rendered dynamic list is re-rendered by re-invoking its existing render function with already-loaded data (no new network calls, no new logic — just re-running the same render path that already exists).
7. **Supabase data stays English** (factory names, brand names, SKU numbers/descriptions, product names, RFQ content, uploaded file names, dates from DB) — these are interpolated *values*, never translation keys.

---

## 3. Translation policy — what stays in English (please confirm)

These are "text" but should **not** be translated. Defaults chosen below; tell me to change any.

- **D1 — International standard / certification / audit proper names → keep English.**
  ISO 9001/13485/14001/22000/22716/45001, GMP, COSMOS, ECOCERT, MoCRA, Prop 65, HACCP, FDA, Health Canada, NSF, OEKO-TEX, GOTS, GRS, FSC, BSCI, Sedex/SMETA, WRAP, SA8000, REACH, Bluesign, CPSIA, ASTM F963, INCI, IFRA, SDS/MSDS, FCC, CE, RoHS, USDA Organic, COA, GCC, CPC, C-TPAT, and acronyms FOB/MOQ/MOQ/HTS/AQL/UPC.
  *The descriptive optgroup labels around them ("ISO standards", "Audits", "Cosmetic / personal care", "Food / supplements", "Textile / sustainability", "Universal documents") ARE translated.*
- **D2 — Courier/brand proper nouns → keep English.** SF Express, UPS, FedEx, DHL; retailer names P&G, L'Oréal, Unilever, Sephora, Walmart. (The "Other" option next to couriers IS translated.)
- **D3 — Country names → TRANSLATE** (China→中国, Vietnam→越南, Korea→韩国, India→印度, Bangladesh→孟加拉国). *Confirm — some prefer to keep English.*
- **D4 — The literal CA Prop 65 legal warning text** ("WARNING: This product can expose you to chemicals known to the State of California to cause cancer…") → **keep English** (it is a legally-prescribed US label string). The surrounding instructions ARE translated.
- **D5 — Units & format examples → keep as-is.** `cm`, `kg`, `USD`, `%`, `days`, and example values like `8513.10.2000`, `+86 138 0000 0000`, `sales@factory.com`, `2027-06-20`. The `e.g.` framing word IS translated (例如：).
- **D6 — Emoji/icons (📋 ✓ ⚠ ⛔ 📦 …) → unchanged**, kept verbatim inside the translated strings.

---

## 4. translations.js shape

```js
window.I18N = {
  en: { common:{…}, auth:{…}, nav:{…}, details:{…}, compliance:{…},
        skus:{…}, rfq:{…}, quote:{…}, samples:{…}, orders:{…},
        upload:{…}, artwork:{…}, audit:{…}, inspection:{…} },
  zh: { …same keys… }
};
// t('compliance.expiredAgo',{n:5}) -> "Expired 5d ago" / "已过期 5 天"
```

Key style: dot-namespaced (`namespace.camelCaseName`). Interpolation tokens: `{n}`, `{date}`, `{name}`, `{count}`, etc. ZH strings mirror every EN key exactly.

---

## 5. Full key inventory (English source shown; 中文 produced in translations.js)

### 5.1 `common.*` (shared across panes — deduped)
| key | EN |
|-----|----|
| common.upload | Upload |
| common.uploading | Uploading... |
| common.saving | Saving... |
| common.save | Save |
| common.cancel | Cancel |
| common.view | View |
| common.replace | Replace |
| common.delete | Delete |
| common.edit | Edit |
| common.add | + Add |
| common.addDocument | + Add document |
| common.choosePdf | Choose PDF |
| common.pdfOnlyMax | PDF only, up to 25 MB |
| common.uploadDocument | Upload Document |
| common.notes | Notes |
| common.notesOptional | Notes (optional) |
| common.issueDate | Issue Date |
| common.expiryDate | Expiry Date * |
| common.select | — Select — |
| common.optional | optional |
| common.none | None |
| common.error | Error: {msg} |
| common.loading | Loading... |
| common.statusActive | Active |
| common.statusExpired | Expired {n}d ago |
| common.statusWarnLeft | ⚠ {n}d left |
| common.statusDaysLeft | {n}d left |
| common.statusNotUploaded | Not uploaded |
| common.certNo | Cert #{n} |
| common.issuedByMeta | Issued by {x} |
| common.expiresMeta | Expires {date} |

### 5.2 `auth.*` (login / signup / reset — static + JS)
| key | EN |
|-----|----|
| auth.portalName | Supplier Portal |
| auth.tabSignIn | Sign In |
| auth.tabRegister | Register |
| auth.tabReset | Reset Password |
| auth.emailLabel | Email Address |
| auth.emailPh | your@email.com |
| auth.passwordLabel | Password |
| auth.passwordMinLabel | Password (min 6 characters) |
| auth.confirmPassword | Confirm Password |
| auth.signInBtn | Sign In |
| auth.createAccountBtn | Create Account |
| auth.sendResetBtn | Send Reset Link |
| auth.resetSent | Reset link sent! Check your email. |
| auth.showPassword | Show password |
| auth.hidePassword | Hide password |
| auth.fillAll | Please fill in all fields. |
| auth.passwordMin | Password must be at least 6 characters. |
| auth.passwordMismatch | Passwords do not match. |
| auth.creating | Creating... |
| auth.signupFailed | Signup failed. Please try again. |
| auth.connError | Connection error: {msg} |
| auth.enterEmailPass | Please enter your email and password. |
| auth.signingIn | Signing in... |
| auth.incorrect | Incorrect email or password. |

### 5.3 `nav.*` (topbar + tabs)
| key | EN |
|-----|----|
| nav.portalTitle | Supplier Portal |
| nav.signOut | Sign out |
| nav.tabDetails | Factory Details |
| nav.tabRfqs | RFQs |
| nav.tabSamples | Product Development |
| nav.tabOrders | Orders |
| nav.tabCatalog | Catalog |
| nav.tabDeck | Company Deck |
| nav.tabQuotes | Quote Sheets |
| nav.tabCompliance | Compliance |
| nav.tabProductCompliance | Product Compliance |
| nav.badgeNeedAction | {n} need action |

### 5.4 `details.*` (Factory Details pane)
| key | EN |
|-----|----|
| details.welcomeTitle | Welcome aboard. |
| details.welcomeBody | The more detail you share about your factory, the better we can match you with the right opportunities. Please complete your profile in full — and don't forget the **other tabs** to upload your catalog, company deck, and pricing sheets. |
| details.bizCardTitle | Your Business Card |
| details.bizCardBody | This is the card we scanned when we connected. If anything looks off, please correct it in the form below. |
| details.factoryInfo | Factory Information |
| details.nameEn | Factory Name (English) * |
| details.nameEnPh | e.g. Guangzhou ABC Manufacturing Co. |
| details.nameLocal | Factory Name (Local language) |
| details.nameLocalPh | e.g. 广州ABC制造有限公司 |
| details.telephone | Telephone * |
| details.country | Country * |
| details.countryPh | e.g. China |
| details.address | Street Address * |
| details.addressPh | 123 Factory Road, Industrial Zone |
| details.city | City * |
| details.cityPh | e.g. Guangzhou |
| details.state | State / Province |
| details.statePh | e.g. Guangdong |
| details.postal | Postal Code |
| details.salesContact | Sales Contact |
| details.contactName | Contact Name * |
| details.contactNamePh | e.g. Cici Lin |
| details.mobile | Mobile / WhatsApp * |
| details.contactEmail | Email Address * |
| details.contactEmailPh | sales@factory.com |
| details.wechat | WeChat ID |
| details.whatsapp | WhatsApp |
| details.aboutCompany | About Your Company |
| details.aboutBody | Briefly describe your factory in your own words — what you make, what makes you unique, who you serve. **Any language is fine.** This helps our team understand and categorize your business. |
| details.aboutPh | e.g. We manufacture skin care packaging — primarily glass jars and pump bottles… |
| details.categories | Manufacturing Categories * |
| details.categoriesBody | Select all categories that apply to your factory and enter the approximate percentage of your business each represents. All percentages should add up to 100%. |
| details.loadingCategories | Loading categories... |
| details.categoryTotal | Category Total |
| details.markets | Global Markets Served * |
| details.marketsBody | Select all markets your factory currently exports to and enter the approximate percentage of your business each represents. |
| details.loadingMarkets | Loading markets... |
| details.marketTotal | Market Total |
| details.certifications | Certifications |
| details.certsBody | Select all certifications your factory currently holds. |
| details.loadingCerts | Loading certifications... |
| details.notListed | Not listed? Add it here |
| details.certCustomPh | e.g. REACH, Bluesign... |
| details.saveBtn | Save Factory Details |
| details.updateBtn | Update Factory Details |
| details.saveOk | ✓ Factory details saved successfully! |
| details.statusApproved | Your factory is approved and active in our supplier network. |
| details.statusReview | Your registration is under review. Our team will be in touch shortly. |
| details.fillIn | Please fill in: {fields} |
| details.errLoadCategories | Error loading categories. Please refresh. |
| details.preselected | All products in this category have been pre-selected. Simply uncheck any products your factory does not manufacture. |
| details.specifyProducts | Specify Products |
| details.allToggle | All |
| details.noneToggle | None |
| details.addCustomPh | Not listed? Add it here... |
| details.pending | pending |
| details.enterCertName | Please enter a certification name. |
| (field names for validation) details.fName/​Telephone/​Address/​City/​Country/​ContactName/​Mobile/​Email | Factory name / Telephone / Address / City / Country / Contact name / Mobile / Email |

### 5.5 `compliance.*` (Compliance Documents pane + modal)
| key | EN |
|-----|----|
| compliance.title | Compliance Documents |
| compliance.intro | Upload the actual certificate PDF for each certification listed below. Items below are based on what you selected on the **Factory Details** tab — to add or remove a certification, update your selections there. |
| compliance.otherDocs | Other Documents |
| compliance.otherDocsBody | Business licenses, insurance certificates, factory profiles, and any other compliance documents not covered above. |
| compliance.docType | Document Type * |
| compliance.grpUniversal | Universal documents |
| compliance.grpIso | ISO standards |
| compliance.grpCosmetic | Cosmetic / personal care |
| compliance.grpFood | Food / supplements |
| compliance.grpTextile | Textile / sustainability |
| compliance.grpAudits | Audits |
| compliance.optBusinessLicense | Business License |
| compliance.optInsurance | Insurance Certificate |
| compliance.optFactoryProfile | Factory Profile / Capability Statement |
| compliance.optOther | Other |
| compliance.specifyType | Specify type * |
| compliance.specifyTypePh | e.g. C-TPAT, Quality Manual |
| compliance.continueUpload | Continue to upload |
| compliance.saveFirst | Save your factory details first. |
| compliance.errLoadDocs | Error loading documents. |
| compliance.noCertsYet | No certifications uploaded yet. Use the **"+ Add Other Document"** button below to upload any certification — it will automatically register on your Factory Details page once uploaded. |
| compliance.selfDeclMeta | Self-declaration on company letterhead with chop/seal |
| compliance.noCertOnFile | No certificate on file |
| compliance.tagSelfDecl | Self-declaration |
| compliance.tagCertification | Certification |
| compliance.uploadBtn | + Upload |
| compliance.modalTitleUpload | Upload: {type} |
| compliance.modalTitleReplace | Replace: {type} |
| compliance.guidanceSelfDecl | **Self-declaration required.** Please upload a signed self-attestation document on company letterhead, signed and stamped with your company chop/seal, stating compliance with **{type}**. Include the effective date and any review date you commit to. |
| compliance.guidanceCert | Upload the actual certificate PDF. Include the certificate number, issuing body, issue/expiry dates as printed on the certificate. |
| compliance.docRefOptional | Document Reference (optional) |
| compliance.signedByOptional | Signed By (optional) |
| compliance.signedByPh | e.g. CEO, QA Director |
| compliance.certNumber | Certificate Number |
| compliance.issuedBy | Issued By |
| compliance.issuedByPh | e.g. TÜV SÜD, BSCI Foundation |
| compliance.notesScopePh | Optional notes — scope, exclusions, etc. |
| compliance.uploadNewVersion | Upload New Version |
| compliance.expiryRequired | Expiry date is required. |
| compliance.expiryAfterIssue | Expiry date must be after issue date. |
| compliance.choosePdf | Please choose a PDF file. |
| compliance.onlyPdf | Only PDF files are accepted. |
| compliance.over25 | File is over 25 MB. Please reduce file size. |
| compliance.storageFailed | Storage upload failed: {x} |
| compliance.dbFailed | Database save failed: {x} |
| compliance.deleteConfirm | Delete this compliance document? This cannot be undone. |
| compliance.deleteFailed | Delete failed: {x} |
| compliance.dlLinkFailed | Could not generate download link: {status} |
| compliance.bannerReady | ✓ All required compliance documents are current |
| compliance.bannerBlocking | ⛔ {n} compliance issue(s) blocking new orders |
| compliance.bannerWarnings | ⚠ {n} compliance warning(s) |
| compliance.bannerLastChecked | Last checked just now. |
| compliance.bannerUnavailable | ⚠ Compliance status check unavailable |

### 5.6 `skus.*` (Product Compliance pane + modal)
| key | EN |
|-----|----|
| skus.title | Product Compliance Documents |
| skus.intro | For each SKU you produce for us, upload the required compliance documents (test reports, certifications, etc). If a document isn't ready yet, mark it "Not Complete" with an expected date so we can plan around it. |
| skus.modeUpload | 📄 Upload Document |
| skus.modeIncomplete | ⏳ Not Complete Yet |
| skus.category | Category * |
| skus.catSafety | Safety Testing |
| skus.catRegulatory | Regulatory |
| skus.catSubstantiation | Substantiation / Claims Testing |
| skus.catChildrens | Children's Products |
| skus.catIngredient | Ingredient & Composition |
| skus.catOther | Other |
| skus.docType | Document Type * |
| skus.selectCatFirst | — Select category first — |
| skus.specifyDocType | Specify document type * |
| skus.specifyDocTypePh | e.g. Walmart Item Setup Sheet |
| skus.certReportNo | Certificate / Report Number |
| skus.testLab | Test Lab |
| skus.testLabPh | e.g. Eurofins, SGS |
| skus.notesScopePh | Optional notes — exclusions, scope, etc. |
| skus.incompleteBox | Mark this certification as "in progress" — let us know when you expect to have it. Once you have the actual certificate, you can upload it here and replace this placeholder. |
| skus.expectedDate | Expected Completion Date * |
| skus.incompleteNotesPh | Any context — testing in progress, lab name, etc. |
| skus.saveFirst | Save your factory details first. |
| skus.loadingSkus | Loading your SKUs... |
| skus.couldNotLoad | Could not load SKUs. |
| skus.noSources | You are not yet a source for any SKUs in our system. Once we approve a quote and add your factory as a source, those SKUs will appear here. |
| skus.noSkusYet | No SKUs yet. |
| skus.noDocsForSku | No compliance documents yet for this SKU. Click **+ Add Document** below. |
| skus.brandLabel | Brand: {x} |
| skus.addDocument | + Add Document |
| skus.inProgress | ⏳ In Progress |
| skus.expectedBy | Expected by {date} |
| skus.overdue | — overdue |
| skus.tbd | TBD |
| skus.uploadNow | + Upload Now |
| skus.labMeta | Lab: {x} |
| skus.modalEditIncomplete | Edit "Not Complete" entry |
| skus.modalUploadReplace | Upload Document (replaces "Not Complete" placeholder) |
| skus.modalReplace | Replace Document |
| skus.modalAdd | Add Compliance Document |
| skus.modalContext | SKU: {model} — {desc} |
| skus.specifyBelow | (specify below) |
| skus.selectCategory | Select a category. |
| skus.specifyADocType | Specify a document type. |
| skus.selectADocType | Select a document type. |
| skus.expectedRequired | Expected completion date is required. |

### 5.7 `rfq.*` (RFQ list)
| key | EN |
|-----|----|
| rfq.empty | No RFQs yet |
| rfq.emptyBody | When our sourcing team sends you a Request for Quotation, it will appear here. |
| rfq.loading | Loading RFQs... |
| rfq.errLoad | Error loading RFQs: {msg} |
| rfq.badgeNew | New RFQ |
| rfq.badgeApproved | ✓ Approved |
| rfq.badgeMoreInfo | ⚠ More Info Requested |
| rfq.badgeQuotesSubmitted | ✓ {n} Quotes Submitted |
| rfq.badgeQuoteSubmitted | Quote Submitted |
| rfq.badgeDraft | Draft Saved |
| rfq.badgeNotApproved | Not Approved |
| rfq.bannerMoreInfo | ⚠ Buyer requested additional information — Option {opt} |
| rfq.bannerMoreInfoBody | Please update your quote below to address this request. |
| rfq.bannerNotApproved | Not Approved — Option {opt} |
| rfq.detQuantity | Quantity |
| rfq.detPackaging | Packaging |
| rfq.detCertsRequired | Certifications Required |
| rfq.detCountry | Country of Manufacture |
| rfq.specifications | Specifications |
| rfq.cosmeticNote | Cosmetic Product: Please include your INCI ingredient list and formulation details with your quote. |

### 5.8 `quote.*` (Quote form — single, kit, multi-FOB, recommended-docs panel)
| key | EN |
|-----|----|
| quote.formTitleNew | Submit a New Quote |
| quote.formTitleUpdate | Update Your Quote (Option {opt}) |
| quote.submitBtn | Submit Quote |
| quote.updateBtn | Update Quote |
| quote.saveDraft | 💾 Save Draft |
| quote.unitFob | Unit FOB Price (USD) * |
| quote.unitFobPh | e.g. 2.5000 |
| quote.pkgCost | Packaging Cost / unit (USD) * |
| quote.pkgCostPh | e.g. 0.3500 |
| quote.totalFob | Total FOB (calculated) |
| quote.priceSeparatelyNote | Please quote unit price and packaging cost separately. Total FOB will be calculated automatically. |
| quote.bulkPricing | Bulk / unpackaged pricing |
| quote.bulkOptional | (optional) |
| quote.bulkBody | If this item were supplied in bulk with no retail packaging (e.g. for inclusion in a set), what would your price be? |
| quote.bulkPrice | Bulk price / unit (USD) |
| quote.bulkPricePh | e.g. 0.3200 |
| quote.bulkUnits | Units / bulk master carton |
| quote.bulkUnitsPh | e.g. 100 |
| quote.moq | MOQ (Minimum Order Quantity) * |
| quote.moqPh | e.g. 1000 |
| quote.fobPort | FOB Port * |
| quote.fobPortHint | (this quote is for shipping from) |
| quote.fobPortPh | e.g. Yantian, Shekou, Shanghai |
| quote.htsCode | HTS Code (if known) |
| quote.htsCodePh | e.g. 8513.10.2000 |
| quote.countryMfr | Country of Manufacture |
| quote.optChina/Vietnam/Korea/India/Bangladesh/Other | China / Vietnam / Korea / India / Bangladesh / Other |
| quote.factoryModel | Existing factory model number (if applicable) |
| quote.factoryModelPh | e.g. SKU-A123 — leave blank if this is a custom build |
| quote.prodSpecs | Product Specifications / Notes |
| quote.prodSpecsPh | Describe what you can produce, any variations, materials, etc. |
| quote.unitDims | Unit Dimensions (optional) |
| quote.length | Length (cm) |
| quote.width | Width (cm) |
| quote.height | Height (cm) |
| quote.unitWeight | Unit Weight (kg) |
| quote.leadTimes | Lead Times |
| quote.prodLead | Production Lead Time (days) * |
| quote.prodLeadPh | e.g. 45 |
| quote.sampleLead | Sample Lead Time (days) * |
| quote.sampleLeadPh | e.g. 14 |
| quote.timelineTitle | 📅 Production Timeline Commitment |
| quote.timelineBody | Commit to the days you need for each stage. Sample submission is days from quote acceptance. Every other stage is days from when we approve the golden sample. |
| quote.timelineBuyerRef | Buyer targets shown for reference. |
| quote.tlSampleSub | Sample submission |
| quote.tlFromAcceptance | (days from quote acceptance) |
| quote.tlMaterials | Materials on hand |
| quote.tlAfterGolden | (days after golden sample) |
| quote.tlMpStart | Mass production starts |
| quote.tlMpEnd | Mass production ends |
| quote.tlInspection | Pre-shipment inspection |
| quote.tlCargoReady | Cargo ready |
| quote.tlTarget | target ≤{n}d |
| quote.tlNotes | Timeline notes / caveats (optional) |
| quote.tlNotesPh | e.g. Materials lead time depends on supplier confirmation |
| quote.complianceDocsSection | Compliance & Documents |
| quote.complianceDocsTitle | 📋 Compliance Documents |
| quote.complianceDocsHint | (INCI + Formulation required for cosmetics, optional for others) |
| quote.complianceDocsBody | For cosmetic products, both INCI list AND full formulation breakdown are required. This is industry standard… Formulation files are stored confidentially. Skip if non-cosmetic. |
| quote.inciPdf | INCI List PDF |
| quote.inciDesc | Standardized ingredient list (regulatory order, no percentages) |
| quote.formulationPdf | Formulation PDF |
| quote.confidential | CONFIDENTIAL |
| quote.formulationDesc | Quantitative breakdown — ingredient %, role, active concentrations |
| quote.currentFile | Current: {name} |
| quote.certsTestReports | Certifications & Test Reports |
| quote.buyerRequested | Buyer requested: {x} |
| quote.addCertsHint | Add any SKU-specific certifications (FDA, ISO, FCC, CE, RoHS, USDA Organic, etc.) |
| quote.addCertBtn | ＋ Add a Certification |
| quote.certNamePh | Certification name (e.g. FDA Registration) |
| quote.replaceByUpload | (replace by uploading a new file) |
| quote.kitTitle | 🧩 This is a multi-component set |
| quote.kitBody | Please quote each component separately — your per-unit cost and the freight to bring that component to the assembly location. Add your assembly cost at the bottom. |
| quote.kitComponent | Component |
| quote.kitOrderQty | Order Qty |
| quote.kitCostUnit | Cost/unit (USD) |
| quote.kitFreight | Freight to assembly |
| quote.kitNoComponents | No components defined for this kit. |
| quote.kitAssemblyCost | Assembly cost / set (USD) |
| quote.kitNotesOptional | Notes (optional) |
| quote.kitSubmit | Submit Kit Quote |
| quote.kitUpdate | Update Kit Quote |
| quote.kitSubmitted | ✓ Kit quote submitted. |
| quote.kitLoading | Loading components… |
| quote.kitAssembly | Assembly |
| quote.kitNeedOne | Please enter a cost for at least one component. |
| quote.multiFobTitle | 💡 Submit one quote per FOB origin |
| quote.multiFobBody | If you can ship from multiple ports with different pricing (e.g. Yantian vs Shanghai), please submit a separate quote for each port. Click "+ Add Another Quote" after submitting your first. |
| quote.statusSubmitted | Submitted |
| quote.statusDraft | Draft |
| quote.statusApproved | ✓ Approved |
| quote.statusNotApproved | Not Approved |
| quote.statusInfoRequested | Info Requested |
| quote.noFobPort | ⚠ no FOB port |
| quote.summaryLine | FOB: ${fob} + Pkg: ${pkg} = ${total} · MOQ: {moq} |
| quote.editBtn | ✏ Edit |
| quote.addAnother | ＋ Add Another Quote (different FOB origin) |
| quote.notFound | Quote not found. |
| quote.recDocsTitle | 📋 Recommended Documents for this Category |
| quote.recDocsTestSpecs | {n} test specs |
| quote.recDocsOptional | Optional but recommended |
| quote.recDocsBody | These documents strengthen your quote and avoid back-and-forth review cycles. You can submit your quote without them — but providing them speeds approval. |
| quote.recCritical | Critical Certifications |
| quote.recImportant | Important Certifications |
| quote.recNiceToHave | Nice-to-Have Certifications |
| quote.recOther | Other Certifications |
| quote.recTestReports | Test Reports / Numeric Specs |
| quote.tierCritical | CRITICAL |
| quote.tierImportant | IMPORTANT |
| quote.tierNice | NICE-TO-HAVE |
| quote.countCritical | {n} critical |
| quote.countImportant | {n} important |
| quote.countNice | {n} nice-to-have |
| quote.specMin | min {n} |
| quote.specMax | max {n} |
| quote.specTarget | Target: {range}{unit} — provide a test report or COA showing this |
| quote.prop65MustConform | 🚨 CA Prop 65 Strategy: Must Conform. Final product must contain no detectable Prop 65-listed chemicals. Provide third-party Prop 65 chemical screening test report from an accredited lab. Reformulation required if any listed chemical is present. |
| quote.prop65WarnLabel | 🚨 CA Prop 65 Strategy: Warning Label Acceptable. Standard CA Prop 65 warning must appear on packaging artwork ("WARNING: …"). Submit packaging mockup with warning label visible. |
| quote.prop65Flexible | 🚨 CA Prop 65: Flexible. Either conformance (no detectable listed chemicals) OR a packaging warning label is acceptable. Conformance is preferred but warning label is OK. |
| quote.factoryNotLoaded | Factory not loaded. |
| quote.htsInvalid | HTS code format looks invalid — expected e.g. 8513.10.2000 or 3304.10. Please correct or clear it. |
| quote.draftSaved | ✓ Draft saved — you can return to finish later. |
| quote.saveFailed | Save failed: {x} |
| quote.needPriceMoq | Please enter at least Unit FOB price and MOQ. |
| quote.needFobPort | Please enter the FOB Port for this quote. If you can ship from multiple ports, submit a separate quote for each. |
| quote.submitting | Submitting... |
| quote.inciUploadFailed | INCI upload failed: {x} |
| quote.inciUploadError | INCI upload error: {x} |
| quote.formUploadFailed | Formulation upload failed: {x} |
| quote.formUploadError | Formulation upload error: {x} |
| quote.updatedOk | ✓ Quote updated successfully! |
| quote.submittedOk | ✓ Quote submitted successfully! Our team will review it shortly. |
| quote.submitFailed | Submit failed: {x} |
| quote.fileBadCert | File "{name}" doesn't look like a certification document. Please upload a PDF or image (JPG, PNG, etc.). |
| quote.fileWrongType | File "{name}" is a {type} file — please upload the certification as a PDF or image. |

### 5.9 `samples.*` (Product Development pane)
| key | EN |
|-----|----|
| samples.loading | Loading samples... |
| samples.empty | No products in development |
| samples.emptyBody | After a quote you submit is accepted, the project will appear here. You'll confirm carton dimensions, upload product images, ship samples, and track approval — all from this tab. |
| samples.errLoad | Could not load samples: {msg} |
| samples.statusAwaitingFirst | Awaiting first sample |
| samples.statusAwaitingApproval | Awaiting approval |
| samples.statusRevision | Revision requested |
| samples.versionHistory | Version History |
| samples.verApproved | ✓ Approved |
| samples.verRejected | ✗ Rejected |
| samples.verRevision | ↻ Revision requested |
| samples.shipped | Shipped {date} |
| samples.feedbackOn | Feedback from buyer on Version {n}: |
| samples.shipInitial | Ship Initial Sample (Version {n}) |
| samples.shipRevised | Ship Revised Sample (Version {n}) |
| samples.shipDate | Ship date * |
| samples.destination | Destination * |
| samples.destTbgChina | TBG China Office |
| samples.destTbgUs | TBG US Office |
| samples.destTestingLab | Testing Lab (specify address) |
| samples.destOther | Other (specify address) |
| samples.addressLabel | Address * |
| samples.addressPh | Full destination address |
| samples.carrier | Carrier * |
| samples.trackingNo | Tracking number * |
| samples.trackingPh | e.g. SF1234567890 |
| samples.notesPh | Anything to call out about this version |
| samples.photoRequired | Sample photo (required) |
| samples.markShipped | Mark Sample as Shipped |
| samples.withBuyer | Sample Version {n} is with the buyer for evaluation. You'll be notified once a decision is made. |
| samples.shipDateReq | Ship date is required. |
| samples.addressReq | Address is required for testing lab or other destinations. |
| samples.trackingReq | Tracking number is required. |
| samples.photoReq | A sample photo is required. |
| samples.markedShipped | ✓ Sample Version {n} marked as shipped. The buyer has been notified. |
| samples.checkingItems | Checking outstanding items... |
| samples.cartonConfirmed | ✓ Carton Dimensions Confirmed |
| samples.cartonAction | 📦 Carton Dimensions — Action Required |
| samples.cartonConfirmedOn | Confirmed on {date}. Click any field to update if needed. |
| samples.cartonBody | Confirm your actual packaging dimensions. Master case dimensions are required before a PO can be issued. |
| samples.innerPack | Inner Case Pack (recommended) |
| samples.unitsPerInner | Units per inner |
| samples.weightKg | Weight (kg) |
| samples.masterPack | Master Case Pack (required for PO) |
| samples.unitsPerMaster | Units per master |
| samples.casesPerPallet | Master cases per pallet (optional) |
| samples.saveDimensions | Save Dimensions |
| samples.assetsTitle | 📸 Product Assets |
| samples.assetsBody | Upload production-ready assets for this product. The buyer needs these for catalog, retailer setup, and tooling reference. |
| samples.assetImages | 📸 Product Images (multiple) |
| samples.assetTechDrawing | 📐 Technical Drawing (PDF or image) |
| samples.assetDieLines | 📦 Packaging Die Lines (PDF or AI) |
| samples.asset3dStep | ⚙ 3D STEP File (.step, .stp) |
| samples.assetManual | 📖 User Manual (where applicable) |
| samples.assetOther | 📄 Other Document (specify type) |
| samples.assetOtherPh | e.g. Tech spec, Material spec |
| samples.loadingAssets | Loading uploaded assets... |
| samples.dimsSavedComplete | ✓ Dimensions saved. Master case info is complete — PO can proceed once other requirements are met. |
| samples.dimsSavedIncomplete | ✓ Saved. Master case info is incomplete — fill in all 5 master fields to satisfy the PO requirement. |
| samples.saveFailed | Save failed: {x} |
| samples.chooseFileFirst | Please choose a file first. |
| samples.uploadedN | ✓ Uploaded {n} file(s). |
| samples.uploadedPartial | ⚠ Uploaded {ok}, {fail} failed. |
| samples.allFailed | All uploads failed. Files must be <25 MB. |
| samples.specifyTypeFirst | Please specify a document type first. |
| samples.noAssets | No assets uploaded yet. |
| samples.errLoadAssets | Could not load assets: {x} |
| samples.fileTooLarge | File too large. Must be under 25 MB. |
| samples.complianceUnavailable | Compliance check unavailable (HTTP {status}) |
| samples.readyForPo | ✓ Ready for PO. No outstanding compliance items. |
| samples.poBlocked | ⛔ {n} item(s) must be addressed before PO can issue |
| samples.poRecommended | ⚠ {n} recommended item(s) |
| samples.actionCheckErr | Action check error: {x} |
| samples.uploadShort | 📎 Upload |
| samples.enterExpiryPrompt | Enter expiry date (YYYY-MM-DD).\n\nIf this document does not expire (e.g. business license, self-declaration), leave blank to set far-future placeholder.\n\nExample: 2027-06-20 |
| samples.enterIssuerPrompt | Optionally enter the issuing body (e.g. SGS, Bureau Veritas, Health Canada).\n\nLeave blank to skip. |
| samples.storageFailedHttp | Storage upload failed (HTTP {status}) |
| samples.uploadFailed | Upload failed: {x} |

### 5.10 `orders.*` (Orders pane — contracts + milestones)
| key | EN |
|-----|----|
| orders.loading | Loading orders... |
| orders.empty | No active orders |
| orders.emptyBody | When your golden sample is approved and we issue a Purchase Order, your production milestone schedule will appear here. |
| orders.errLoad | Could not load orders: {x} |
| orders.msSampleSub | Sample Submission |
| orders.msMaterials | Materials On Hand |
| orders.msMpStart | Mass Production Start |
| orders.msMpEnd | Mass Production End |
| orders.msInspection | Pre-Shipment Inspection |
| orders.msCargoReady | Cargo Ready |
| orders.msCompleted | ✓ Completed |
| orders.msOnTrack | ✓ On track |
| orders.msDelayed | ⚠ Delayed |
| orders.msAtRisk | ⚠ At risk |
| orders.msOverdue | ⚠ Overdue |
| orders.msPending | Pending |
| orders.confirmOnSchedule | ✓ Confirm on schedule |
| orders.flagDelay | ⚠ Flag delay |
| orders.requestDateChange | Request date change |
| orders.due | Due: {date} |
| orders.orig | (orig {date}) |
| orders.inProduction | In production |
| orders.bannerReviewContract | Action required: review and accept the contract |
| orders.awaitingAcceptance | Awaiting acceptance |
| orders.bannerUploadSigned | Action required: print, sign, chop, and upload the executed contract |
| orders.awaitingSigned | Awaiting signed PDF |
| orders.bannerExecuted | Contract fully executed. Production milestones will be loaded shortly. |
| orders.fullyExecuted | Fully executed |
| orders.contractPdfV | Contract PDF (v{n}) |
| orders.downloadPdf | ↓ Download PDF |
| orders.reviewBody | Please review the contract above. Clicking Accept below confirms you have read and agree to the terms. After accepting, you will be prompted to print the contract, apply your signature and company chop, and upload the executed PDF to complete the process. |
| orders.acceptContract | ✓ Accept Contract |
| orders.acceptAudit | Your acceptance will be recorded with timestamp and audit trail. |
| orders.acceptedBy | ✓ Contract accepted {date} by {name} |
| orders.finalStep | Final step: Print the contract above, apply your authorized signature and company chop on the signature page, scan the executed document, and upload the PDF below. The contract will be considered fully executed once uploaded. |
| orders.uploadSignedPdf | 📎 Upload signed & chopped PDF |
| orders.pdfLocked | PDF only. Once uploaded, the file is locked. |
| orders.executedOn | ✓ Contract fully executed {date}. Production milestones will appear once timeline is locked in. |
| orders.viewExecuted | ↓ View your executed copy |
| orders.acceptPrompt | Type your full name to digitally accept Purchase Order {po}.\n\nBy accepting, you confirm you are authorized to commit your company to the terms of this contract. Your name, timestamp, and IP address will be recorded as part of the audit trail.\n\nAfter acceptance, you will be prompted to upload the physically signed and chopped contract. |
| orders.acceptedAlert | ✓ Contract accepted. Please print, sign, and apply your company chop, then upload the executed PDF. |
| orders.couldNotAccept | Could not accept contract: {x} |
| orders.uploadPdfOnly | Please upload a PDF file only. |
| orders.uploadingWait | Uploading... please wait. |
| orders.confirmUploaderName | Confirm your name for the record (who uploaded the signed contract): |
| orders.signedUploaded | ✓ Signed PDF uploaded successfully. Contract is now fully executed. |
| orders.uploadFailed | Upload failed: {x} |
| orders.confirmMilestone | Confirm this milestone is on track for the agreed date? |
| orders.describeDelay | Briefly describe the delay (the buyer will be notified): |
| orders.proposeNewDate | Propose a new date for {ms} (current: {date}).\n\nFormat: YYYY-MM-DD |
| orders.reasonForChange | Reason for the change request (the buyer must approve): |
| orders.requestSubmitted | Request submitted. The buyer will review and respond. |
| orders.couldNotSubmit | Could not submit: {x} |

### 5.11 `upload.*` (Catalog / Company Deck / Quote Sheets panes + file list)
| key | EN |
|-----|----|
| upload.catalogTitle | Product Catalog |
| upload.catalogBody | Upload your product catalog. Accepted: PDF, PowerPoint (.pptx) |
| upload.catalogBtn | Upload Catalog |
| upload.pdfOrPpt | PDF or PowerPoint files |
| upload.catalogOk | Catalog uploaded successfully! |
| upload.deckTitle | Company Presentation |
| upload.deckBody | Upload your company overview or presentation. Accepted: PDF, PowerPoint (.pptx) |
| upload.deckBtn | Upload Company Deck |
| upload.deckOk | Presentation uploaded successfully! |
| upload.quotesTitle | Product Pricing Sheets |
| upload.quotesBody | Upload any existing product pricing sheets or price lists for your factory. These help us understand your product range and pricing structure. Accepted: Excel (.xlsx, .xls) |
| upload.quotesBtn | Upload Quote Sheet |
| upload.excelOnly | Excel files only (.xlsx, .xls) |
| upload.quotesOk | Quote sheet uploaded successfully! |
| upload.uploadedFiles | Uploaded Files |
| upload.viewDownload | View / Download |
| upload.selectFileFirst | Please select a file first. |

### 5.12 `artwork.*` (artwork-factory-review.html — all JS-rendered)
| key | EN |
|-----|----|
| artwork.brandSub | Artwork Review Portal |
| artwork.loading | Loading… |
| artwork.invalidLink | Invalid or expired link. |
| artwork.expiredLink | This link has expired. Please contact your TBG sourcing manager for a new link. |
| artwork.approvedTitle | Artwork Approved |
| artwork.approvedBody | Thank you for your confirmation. |
| artwork.reviewLead | Please review and confirm the attached artwork file. |
| artwork.downloadBtn | ⬇ Download Artwork |
| artwork.approveBtn | ✓ Approve Artwork |
| artwork.flagBtn | ⚠ Flag an Issue |
| artwork.dielineBtn | 📋 Request New Dieline |
| artwork.confirmList | By approving this artwork, you confirm that:<br>• You have reviewed the file against your production dieline<br>• The UPC barcode is correct and scannable<br>• All dimensions and specifications are within tolerance<br>• You can produce this artwork as submitted |
| artwork.enterName | Please enter your name to confirm approval |
| artwork.namePh | Your full name |
| artwork.confirmApproval | Confirm Approval |
| artwork.issueType | Issue type |
| artwork.itWrongDieline | Wrong dieline |
| artwork.itBomImpact | BOM impact |
| artwork.itTreatment | Treatment change |
| artwork.itColor | Color mismatch |
| artwork.itStructural | Structural change |
| artwork.itOther | Other |
| artwork.description | Description |
| artwork.descPh | Describe the issue… |
| artwork.submitIssue | Submit Issue |
| artwork.noFile | No artwork file available yet. |
| artwork.enterNameAlert | Please enter your name. |
| artwork.approvalRecorded | Approval Recorded |
| artwork.approvalThanks | Thank you, {name}. Your confirmation has been logged. |
| artwork.describeIssueAlert | Please describe the issue. |
| artwork.issueReported | Issue Reported |
| artwork.issueReportedBody | Your TBG sourcing manager will be in touch shortly. |
| artwork.requestSubmitted | Request Submitted |
| artwork.dielineSubmitted | Dieline revision request submitted. |
| artwork.fallbackName | Artwork |

### 5.13 `audit.*` (audit-report-upload.html — all JS-rendered)
| key | EN |
|-----|----|
| audit.brandSub | Audit Report Upload |
| audit.loading | Loading… |
| audit.invalidLink | Invalid or expired upload link. |
| audit.alreadyReceived | Report already received. Thank you. |
| audit.title | Upload Audit Report |
| audit.lead | Please upload the completed factory audit report. |
| audit.factory | Factory |
| audit.auditLabel | Audit |
| audit.scheduled | Scheduled |
| audit.conductedDate | Conducted date * |
| audit.reportFile | Report file (PDF or image) * |
| audit.overallScore | Overall score % (optional) |
| audit.colorRating | Color rating (optional) |
| audit.colorGreen | Green |
| audit.colorYellow | Yellow |
| audit.colorOrange | Orange |
| audit.colorRed | Red |
| audit.notesOptional | Notes (optional) |
| audit.uploadBtn | Upload Report |
| audit.pastedHint | Image pasted — click Upload to submit |
| audit.thankYou | Thank you |
| audit.dateRequired | Conducted date is required. |
| audit.fileRequired | Please select a report file. |
| audit.uploading | Uploading… |
| audit.uploadFailedStatus | Upload failed ({status}). |
| audit.uploadedTitle | Report Uploaded |
| audit.uploadedBody | Report uploaded successfully. The TBG sourcing team has been notified and will review shortly. |
| audit.errorMsg | Error: {msg} |

### 5.14 `inspection.*` (factory-inspection-confirm.html — all JS-rendered)
| key | EN |
|-----|----|
| inspection.brandSub | Inspection Confirmation |
| inspection.loading | Loading inspection… |
| inspection.missingRef | Missing inspection reference. Please use the link from your email. |
| inspection.notFound | Inspection not found. |
| inspection.title | Inspection Confirmation Required |
| inspection.lead | Please confirm whether the goods for this order will be ready for inspection on the scheduled date. |
| inspection.poNumber | PO Number |
| inspection.factory | Factory |
| inspection.type | Inspection Type |
| inspection.scheduledDate | Scheduled Date |
| inspection.inspector | Inspector |
| inspection.tbd | TBD |
| inspection.aqlLevel | AQL Level |
| inspection.levelPrefix | Level {n} |
| inspection.confirmBtn | ✓ Confirm — Goods will be ready for inspection |
| inspection.flagBtn | ⚠ Flag an Issue — Goods may not be ready |
| inspection.flagPh | Describe the issue (e.g. production delay, material shortage)… |
| inspection.submitIssue | Submit Issue Report |
| inspection.submitting | Submitting… |
| inspection.confirmedTitle | Inspection Confirmed |
| inspection.confirmedBody | Thank you. We have recorded that the goods will be ready for inspection. |
| inspection.flaggedTitle | Issue Reported |
| inspection.flaggedBody | Thank you. Our sourcing team has been notified and will follow up shortly. |
| inspection.describeAlert | Please describe the issue. |

---

## 6. Toggle button — exact placement & styling

- **index.html:** inside `.topbar-r` (right side of header), as a sibling **before** `signout-btn`. Rendered as a `<button>` reusing the *exact* visual treatment of the existing `signout-btn` (12px, neutral color, no background, `font-family:inherit`). No new colors/sizes introduced; only the EN | 中文 label.
- **Token pages** (dark cards): a small toggle in the card's top-right next to the `.brand` block, matching the existing muted subtitle color (`#94a3b8`) and font sizing. No layout shift to the centered card.
- Label shows the language you can switch **to** (e.g. shows "中文" when in EN, "EN" when in ZH) OR a two-part "EN | 中文" with the active side highlighted — **I'll use "EN | 中文" with the active side bold**, since that matches a clean header control. Tell me if you prefer the single-target style.

---

## 7. Counts
- ~**40** common, **~24** auth, **~12** nav, **~50** details, **~45** compliance, **~45** skus, **~20** rfq, **~110** quote, **~70** samples, **~55** orders, **~18** upload, **~33** artwork, **~30** audit, **~28** inspection.
- **Total ≈ 580 keys** (EN + ZH = ~1,160 strings) across `translations.js`.

---

## 8. What I need from you
1. **Approve the approach** (Section 2) and **toggle style** (Section 6).
2. **Confirm the English-only policy** (Section 3 — especially D3 country names and D4 Prop 65 legal text).
3. Flag any string you do **not** want translated, or any key naming you'd change.

On approval I will: build `translations.js` (EN + ZH), wire the 4 pages, and add the toggle — text swap only, nothing moved or restyled.

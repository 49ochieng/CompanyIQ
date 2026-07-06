// Phase 1 STUB — returns hardcoded sample rows shaped like UC-01 Appendix A-02.
// Phase 2 replaces the handler with the real intent whitelist → validator →
// parameterized SQL flow. The model never writes SQL: it only selects an
// intent and fills parameters through this function-calling schema.

const STUB_ROWS = [
    {
        Item: "Protein Power Bar 6ct",
        Brand: "Contoso Nutrition",
        UPC: "049000001234",
        Supplier: "Shanghai Ingredient Co.",
        COO: "CN",
        "Mtl<>USA": "Y",
        "Ingredients Statement": "Soy protein isolate, cane sugar, cocoa butter, almonds, sea salt.",
    },
    {
        Item: "Veggie Burger Patties 4ct",
        Brand: "Contoso Kitchen",
        UPC: "049000005678",
        Supplier: "Golden Harvest Foods Ltd.",
        COO: "CN",
        "Mtl<>USA": "Y",
        "Ingredients Statement": "Soy protein concentrate, brown rice, onion, garlic, spices.",
    },
    {
        Item: "Energy Shake Mix Vanilla",
        Brand: "Contoso Nutrition",
        UPC: "049000009012",
        Supplier: "Shanghai Ingredient Co.",
        COO: "CN",
        "Mtl<>USA": "Y",
        "Ingredients Statement": "Soy protein isolate, natural vanilla flavor, xanthan gum, stevia.",
    },
    {
        Item: "Classic Noodle Bowl",
        Brand: "Contoso Kitchen",
        UPC: "049000003456",
        Supplier: "Golden Harvest Foods Ltd.",
        COO: "CN",
        "Mtl<>USA": "Y",
        "Ingredients Statement": "Wheat flour, wheat gluten, palm oil, salt, seasoning blend.",
    },
    {
        Item: "Pretzel Bites Original",
        Brand: "Contoso Snacks",
        UPC: "049000007890",
        Supplier: "Midwest Bakery Supply Inc.",
        COO: "US",
        "Mtl<>USA": "N",
        "Ingredients Statement": "Wheat flour, water, salt, yeast, soybean oil.",
    },
];

module.exports = {
    name: "queryCompanyData",
    description:
        "Query the company's structured product and item data (items, brands, UPCs, suppliers, ingredients, " +
        "country of origin). This is the primary and preferred source for any question about company products " +
        "or items. Select a whitelisted intent and fill its parameters; never write queries yourself.",
    parameters: {
        type: "object",
        properties: {
            intent: {
                type: "string",
                description: "The whitelisted query intent to run.",
                enum: [
                    "items_by_ingredient_and_coo",
                    "items_by_ingredient",
                    "items_by_supplier",
                    "item_detail",
                ],
            },
            parameters: {
                type: "object",
                description: "Parameters for the selected intent.",
                properties: {
                    ingredient: {
                        type: "string",
                        description: "Ingredient to match in the ingredients statement, e.g. 'soy protein'.",
                    },
                    country_of_origin: {
                        type: "string",
                        description: "Country of origin as a name or ISO code, e.g. 'China' or 'CN'.",
                    },
                    supplier: {
                        type: "string",
                        description: "Supplier name or ID.",
                    },
                    upc: {
                        type: "string",
                        description: "UPC or item ID for a single-item lookup.",
                    },
                },
            },
        },
        required: ["intent"],
    },
    /**
     * STUB handler: filters the hardcoded rows so parameter routing is
     * observable end-to-end. No database is involved in Phase 1.
     * @param {{intent: string, parameters?: Object}} args Arguments filled by the model.
     * @param {Object} context Per-turn context (conversation ID, user scope).
     */
    async handler(args, context) {
        const params = args.parameters || {};
        let rows = STUB_ROWS;

        const ingredient = (params.ingredient || "").toLowerCase();
        if (ingredient) {
            rows = rows.filter((r) =>
                r["Ingredients Statement"].toLowerCase().includes(ingredient)
            );
        }

        const coo = (params.country_of_origin || "").toLowerCase();
        if (coo) {
            const code = coo === "china" ? "cn" : coo === "united states" || coo === "usa" ? "us" : coo;
            rows = rows.filter((r) => r.COO.toLowerCase() === code);
        }

        const supplier = (params.supplier || "").toLowerCase();
        if (supplier) {
            rows = rows.filter((r) => r.Supplier.toLowerCase().includes(supplier));
        }

        if (params.upc) {
            rows = rows.filter((r) => r.UPC === params.upc);
        }

        return {
            intent: args.intent,
            rowCount: rows.length,
            rows,
            note: "Stub sample data (Phase 1). Real scoped SQL arrives in Phase 2.",
        };
    },
};

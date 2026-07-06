// CLI: npm run db:seed
// Idempotent: creates the sbs_test schema/tables if missing and upserts the
// test rows by primary key. Rerunning always converges to the same state.
// Test data only — UC-01 Appendix A-02 items plus variety across ingredients,
// countries, and two retailer scopes so row-level filtering is provable.
const { sql, getPool, closePool } = require("./db");

const SUPPLIERS = [
    { supplier_id: 1, supplier_name: "Fletcher Inc." },
    { supplier_id: 2, supplier_name: "Golden Harvest Foods Ltd." },
    { supplier_id: 3, supplier_name: "Shanghai Ingredient Co." },
    { supplier_id: 4, supplier_name: "Midwest Bakery Supply Inc." },
    { supplier_id: 5, supplier_name: "Baltic Grain Partners" },
];

// UC-01 Appendix A-02 items are 1-3 (verbatim names, Fletcher Inc., COO USA, soy).
const ITEMS = [
    { item_id: 1, item_name: "MyHeart Fried Rice with Vegetables", brand: "MyHeart", upc: "812345000011", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Cooked white rice, mixed vegetables (carrots, peas, corn), soy protein isolate, soy sauce (water, soybeans, wheat, salt), sesame oil, salt." },
    { item_id: 2, item_name: "MyHeart Cheese Enchilada with Organic Corn and Tomatoes", brand: "MyHeart", upc: "812345000028", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Corn tortillas (organic corn masa, water, lime), cheddar cheese, organic tomatoes, textured soy protein, enchilada sauce, onion, spices." },
    { item_id: 3, item_name: "MyHeart Frozen Meat, Broccoli and Cheddar Bowl", brand: "MyHeart", upc: "812345000035", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Seasoned beef, broccoli florets, cheddar cheese sauce, soy protein concentrate, modified corn starch, salt, spices." },
    { item_id: 4, item_name: "Protein Power Bar 6ct", brand: "PeakFuel", upc: "812345000042", supplier_id: 3, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Soy protein isolate, cane sugar, cocoa butter, almonds, sea salt." },
    { item_id: 5, item_name: "Veggie Burger Patties 4ct", brand: "HarvestPlate", upc: "812345000059", supplier_id: 2, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Soy protein concentrate, brown rice, onion, garlic, spices." },
    { item_id: 6, item_name: "Energy Shake Mix Vanilla", brand: "PeakFuel", upc: "812345000066", supplier_id: 3, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Soy protein isolate, natural vanilla flavor, xanthan gum, stevia leaf extract." },
    { item_id: 7, item_name: "Classic Noodle Bowl", brand: "HarvestPlate", upc: "812345000073", supplier_id: 2, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Wheat flour, wheat gluten, palm oil, salt, seasoning blend." },
    { item_id: 8, item_name: "Dumpling Wrappers 50ct", brand: "HarvestPlate", upc: "812345000080", supplier_id: 2, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Wheat flour, water, salt." },
    { item_id: 9, item_name: "Pretzel Bites Original", brand: "SnackRight", upc: "812345000097", supplier_id: 4, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Wheat flour, water, salt, yeast, soybean oil." },
    { item_id: 10, item_name: "Honey Oat Granola", brand: "SnackRight", upc: "812345000103", supplier_id: 4, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Whole grain oats, honey, almonds, sunflower oil, cinnamon." },
    { item_id: 11, item_name: "Tomato Basil Soup", brand: "MyHeart", upc: "812345000110", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Tomatoes, water, cream, basil, sea salt, black pepper." },
    { item_id: 12, item_name: "Rye Crispbread", brand: "NordicCrisp", upc: "812345000127", supplier_id: 5, country_of_origin: "Lithuania", mtl_neq_usa: 1, ingredients_statement: "Whole grain rye flour, water, salt, caraway seeds." },
    { item_id: 13, item_name: "Jasmine Rice 2lb", brand: "HarvestPlate", upc: "812345000134", supplier_id: 2, country_of_origin: "Thailand", mtl_neq_usa: 1, ingredients_statement: "Jasmine rice." },
    { item_id: 14, item_name: "Chili Lime Corn Chips", brand: "SnackRight", upc: "812345000141", supplier_id: 4, country_of_origin: "Mexico", mtl_neq_usa: 1, ingredients_statement: "Ground corn, sunflower oil, chili lime seasoning, salt." },
    { item_id: 15, item_name: "Green Tea Matcha Mix", brand: "PeakFuel", upc: "812345000158", supplier_id: 3, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Matcha green tea powder, cane sugar, rice flour." },
];

// Two distinct retailer scopes with overlapping but different item sets.
const RETAILER_ITEMS = [
    ...[1, 2, 3, 4, 5, 6, 7, 9, 10, 11].map((item_id) => ({ retailer_id: "RETAILER_100", item_id })),
    ...[5, 6, 8, 12, 13, 14, 15].map((item_id) => ({ retailer_id: "RETAILER_200", item_id })),
];

async function main() {
    const pool = await getPool();

    await pool.request().batch(`
        IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'sbs_test')
            EXEC('CREATE SCHEMA sbs_test');
    `);

    await pool.request().batch(`
        IF OBJECT_ID('sbs_test.suppliers') IS NULL
            CREATE TABLE sbs_test.suppliers (
                supplier_id INT NOT NULL PRIMARY KEY,
                supplier_name NVARCHAR(200) NOT NULL
            );

        IF OBJECT_ID('sbs_test.items') IS NULL
            CREATE TABLE sbs_test.items (
                item_id INT NOT NULL PRIMARY KEY,
                item_name NVARCHAR(200) NOT NULL,
                brand NVARCHAR(100) NOT NULL,
                upc VARCHAR(14) NOT NULL,
                supplier_id INT NOT NULL REFERENCES sbs_test.suppliers(supplier_id),
                country_of_origin NVARCHAR(100) NOT NULL,
                mtl_neq_usa BIT NOT NULL,
                ingredients_statement NVARCHAR(MAX) NOT NULL
            );

        IF OBJECT_ID('sbs_test.retailer_items') IS NULL
            CREATE TABLE sbs_test.retailer_items (
                retailer_id VARCHAR(50) NOT NULL,
                item_id INT NOT NULL REFERENCES sbs_test.items(item_id),
                PRIMARY KEY (retailer_id, item_id)
            );
    `);

    for (const s of SUPPLIERS) {
        await pool
            .request()
            .input("id", sql.Int, s.supplier_id)
            .input("name", sql.NVarChar(200), s.supplier_name)
            .query(`
                MERGE sbs_test.suppliers AS t
                USING (SELECT @id AS supplier_id) AS src ON t.supplier_id = src.supplier_id
                WHEN MATCHED THEN UPDATE SET supplier_name = @name
                WHEN NOT MATCHED THEN INSERT (supplier_id, supplier_name) VALUES (@id, @name);
            `);
    }

    for (const i of ITEMS) {
        await pool
            .request()
            .input("id", sql.Int, i.item_id)
            .input("name", sql.NVarChar(200), i.item_name)
            .input("brand", sql.NVarChar(100), i.brand)
            .input("upc", sql.VarChar(14), i.upc)
            .input("supplierId", sql.Int, i.supplier_id)
            .input("coo", sql.NVarChar(100), i.country_of_origin)
            .input("mtl", sql.Bit, i.mtl_neq_usa)
            .input("ingredients", sql.NVarChar(sql.MAX), i.ingredients_statement)
            .query(`
                MERGE sbs_test.items AS t
                USING (SELECT @id AS item_id) AS src ON t.item_id = src.item_id
                WHEN MATCHED THEN UPDATE SET
                    item_name = @name, brand = @brand, upc = @upc, supplier_id = @supplierId,
                    country_of_origin = @coo, mtl_neq_usa = @mtl, ingredients_statement = @ingredients
                WHEN NOT MATCHED THEN INSERT
                    (item_id, item_name, brand, upc, supplier_id, country_of_origin, mtl_neq_usa, ingredients_statement)
                    VALUES (@id, @name, @brand, @upc, @supplierId, @coo, @mtl, @ingredients);
            `);
    }

    await pool.request().query("DELETE FROM sbs_test.retailer_items");
    for (const r of RETAILER_ITEMS) {
        await pool
            .request()
            .input("retailerId", sql.VarChar(50), r.retailer_id)
            .input("itemId", sql.Int, r.item_id)
            .query("INSERT INTO sbs_test.retailer_items (retailer_id, item_id) VALUES (@retailerId, @itemId)");
    }

    const counts = await pool.request().query(`
        SELECT
            (SELECT COUNT(*) FROM sbs_test.suppliers) AS suppliers,
            (SELECT COUNT(*) FROM sbs_test.items) AS items,
            (SELECT COUNT(*) FROM sbs_test.retailer_items) AS retailer_items
    `);
    console.log("Seed complete:", JSON.stringify(counts.recordset[0]));

    await closePool();
}

main().catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
});

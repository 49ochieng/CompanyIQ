// CLI: npm run db:seed
// Idempotent: creates the sbs_test schema/tables if missing and upserts the
// test rows by primary key. Rerunning always converges to the same state.
//
// Test data only. Designed so the UC-01 demo answers are EXACT and stable:
//   soy protein + China, RETAILER_100  -> 3 items  (ids 4, 5, 6)
//   wheat        + China, RETAILER_100 -> 1 item   (id 7)
//   soy protein + China, RETAILER_200  -> 2 items  (ids 5, 6)
// No other seed row may combine (soy protein | wheat) with China, or those
// counts shift. Everything else is free to grow.
const { sql, getPool, closePool, useAdminCredentials } = require("./db");

const SUPPLIERS = [
    { supplier_id: 1, supplier_name: "Fletcher Inc." },
    { supplier_id: 2, supplier_name: "Golden Harvest Foods Ltd." },
    { supplier_id: 3, supplier_name: "Shanghai Ingredient Co." },
    { supplier_id: 4, supplier_name: "Midwest Bakery Supply Inc." },
    { supplier_id: 5, supplier_name: "Baltic Grain Partners" },
    { supplier_id: 6, supplier_name: "Cascadia Organics LLC" },
    { supplier_id: 7, supplier_name: "Andes Fruit Exporters S.A." },
    { supplier_id: 8, supplier_name: "Mekong Rice Trading Co." },
    { supplier_id: 9, supplier_name: "Sicilia Olive Works" },
    { supplier_id: 10, supplier_name: "Maple Ridge Dairy Co-op" },
    { supplier_id: 11, supplier_name: "Rhine Valley Confectionery GmbH" },
    { supplier_id: 12, supplier_name: "Kerala Spice House Pvt Ltd" },
];

// UC-01 Appendix A-02 items are 1-3 (verbatim names, Fletcher Inc., COO USA, soy).
const ITEMS = [
    // --- UC-01 canonical items (do not change) ---
    { item_id: 1, item_name: "MyHeart Fried Rice with Vegetables", brand: "MyHeart", upc: "812345000011", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Cooked white rice, mixed vegetables (carrots, peas, corn), soy protein isolate, soy sauce (water, soybeans, wheat, salt), sesame oil, salt." },
    { item_id: 2, item_name: "MyHeart Cheese Enchilada with Organic Corn and Tomatoes", brand: "MyHeart", upc: "812345000028", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Corn tortillas (organic corn masa, water, lime), cheddar cheese, organic tomatoes, textured soy protein, enchilada sauce, onion, spices." },
    { item_id: 3, item_name: "MyHeart Frozen Meat, Broccoli and Cheddar Bowl", brand: "MyHeart", upc: "812345000035", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Seasoned beef, broccoli florets, cheddar cheese sauce, soy protein concentrate, modified corn starch, salt, spices." },

    // --- the three soy + China items that answer UC-01 (ids 4-6) ---
    { item_id: 4, item_name: "Protein Power Bar 6ct", brand: "PeakFuel", upc: "812345000042", supplier_id: 3, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Soy protein isolate, cane sugar, cocoa butter, almonds, sea salt." },
    { item_id: 5, item_name: "Veggie Burger Patties 4ct", brand: "HarvestPlate", upc: "812345000059", supplier_id: 2, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Soy protein concentrate, brown rice, onion, garlic, spices." },
    { item_id: 6, item_name: "Energy Shake Mix Vanilla", brand: "PeakFuel", upc: "812345000066", supplier_id: 3, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Soy protein isolate, natural vanilla flavor, xanthan gum, stevia leaf extract." },

    // --- the single wheat + China item for the follow-up (id 7) ---
    { item_id: 7, item_name: "Classic Noodle Bowl", brand: "HarvestPlate", upc: "812345000073", supplier_id: 2, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Wheat flour, wheat gluten, palm oil, salt, seasoning blend." },

    // wheat + China but RETAILER_200 only (keeps R100's wheat answer at 1)
    { item_id: 8, item_name: "Dumpling Wrappers 50ct", brand: "HarvestPlate", upc: "812345000080", supplier_id: 2, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Wheat flour, water, salt." },

    { item_id: 9, item_name: "Pretzel Bites Original", brand: "SnackRight", upc: "812345000097", supplier_id: 4, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Wheat flour, water, salt, yeast, soybean oil." },
    { item_id: 10, item_name: "Honey Oat Granola", brand: "SnackRight", upc: "812345000103", supplier_id: 4, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Whole grain oats, honey, almonds, sunflower oil, cinnamon." },
    { item_id: 11, item_name: "Tomato Basil Soup", brand: "MyHeart", upc: "812345000110", supplier_id: 1, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Tomatoes, water, cream, basil, sea salt, black pepper." },
    { item_id: 12, item_name: "Rye Crispbread", brand: "NordicCrisp", upc: "812345000127", supplier_id: 5, country_of_origin: "Lithuania", mtl_neq_usa: 1, ingredients_statement: "Whole grain rye flour, water, salt, caraway seeds." },
    { item_id: 13, item_name: "Jasmine Rice 2lb", brand: "HarvestPlate", upc: "812345000134", supplier_id: 2, country_of_origin: "Thailand", mtl_neq_usa: 1, ingredients_statement: "Jasmine rice." },
    { item_id: 14, item_name: "Chili Lime Corn Chips", brand: "SnackRight", upc: "812345000141", supplier_id: 4, country_of_origin: "Mexico", mtl_neq_usa: 1, ingredients_statement: "Ground corn, sunflower oil, chili lime seasoning, salt." },
    { item_id: 15, item_name: "Green Tea Matcha Mix", brand: "PeakFuel", upc: "812345000158", supplier_id: 3, country_of_origin: "China", mtl_neq_usa: 1, ingredients_statement: "Matcha green tea powder, cane sugar, rice flour." },

    // --- breadth: more countries, suppliers, brands, ingredients -----------
    { item_id: 16, item_name: "Organic Rolled Oats 32oz", brand: "Cascadia Harvest", upc: "812345000165", supplier_id: 6, country_of_origin: "Canada", mtl_neq_usa: 1, ingredients_statement: "Organic whole grain rolled oats." },
    { item_id: 17, item_name: "Almond Butter Smooth", brand: "Cascadia Harvest", upc: "812345000172", supplier_id: 6, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Dry roasted almonds, sea salt." },
    { item_id: 18, item_name: "Trail Mix Cranberry Cashew", brand: "SnackRight", upc: "812345000189", supplier_id: 6, country_of_origin: "United States of America", mtl_neq_usa: 1, ingredients_statement: "Peanuts, cashews, dried cranberries (cranberries, cane sugar), raisins, sunflower oil, salt." },
    { item_id: 19, item_name: "Freeze Dried Mango Slices", brand: "Andes Gold", upc: "812345000196", supplier_id: 7, country_of_origin: "Peru", mtl_neq_usa: 1, ingredients_statement: "Mango." },
    { item_id: 20, item_name: "Banana Chips Sweetened", brand: "Andes Gold", upc: "812345000202", supplier_id: 7, country_of_origin: "Ecuador", mtl_neq_usa: 1, ingredients_statement: "Bananas, coconut oil, cane sugar, natural banana flavor." },
    { item_id: 21, item_name: "Quinoa Blend Tri-Color", brand: "Andes Gold", upc: "812345000219", supplier_id: 7, country_of_origin: "Bolivia", mtl_neq_usa: 1, ingredients_statement: "White quinoa, red quinoa, black quinoa." },
    { item_id: 22, item_name: "Rice Noodles Pad Thai Style", brand: "Mekong Kitchen", upc: "812345000226", supplier_id: 8, country_of_origin: "Vietnam", mtl_neq_usa: 1, ingredients_statement: "Rice flour, water, tapioca starch." },
    { item_id: 23, item_name: "Coconut Milk Full Fat", brand: "Mekong Kitchen", upc: "812345000233", supplier_id: 8, country_of_origin: "Thailand", mtl_neq_usa: 1, ingredients_statement: "Coconut extract, water, guar gum." },
    { item_id: 24, item_name: "Sriracha Chili Sauce", brand: "Mekong Kitchen", upc: "812345000240", supplier_id: 8, country_of_origin: "Vietnam", mtl_neq_usa: 1, ingredients_statement: "Chili peppers, cane sugar, salt, garlic, distilled vinegar, potassium sorbate." },
    { item_id: 25, item_name: "Extra Virgin Olive Oil 500ml", brand: "Sicilia Verde", upc: "812345000257", supplier_id: 9, country_of_origin: "Italy", mtl_neq_usa: 1, ingredients_statement: "Extra virgin olive oil." },
    { item_id: 26, item_name: "Sun Dried Tomatoes in Oil", brand: "Sicilia Verde", upc: "812345000264", supplier_id: 9, country_of_origin: "Italy", mtl_neq_usa: 1, ingredients_statement: "Sun dried tomatoes, sunflower oil, salt, oregano, garlic." },
    { item_id: 27, item_name: "Balsamic Vinegar of Modena", brand: "Sicilia Verde", upc: "812345000271", supplier_id: 9, country_of_origin: "Italy", mtl_neq_usa: 1, ingredients_statement: "Wine vinegar, concentrated grape must, caramel color." },
    { item_id: 28, item_name: "Aged Cheddar Block 8oz", brand: "Maple Ridge", upc: "812345000288", supplier_id: 10, country_of_origin: "Canada", mtl_neq_usa: 1, ingredients_statement: "Pasteurized milk, cheese cultures, salt, enzymes, annatto color." },
    { item_id: 29, item_name: "Salted Butter 1lb", brand: "Maple Ridge", upc: "812345000295", supplier_id: 10, country_of_origin: "Canada", mtl_neq_usa: 1, ingredients_statement: "Pasteurized cream, salt." },
    { item_id: 30, item_name: "Greek Yogurt Plain 32oz", brand: "Maple Ridge", upc: "812345000301", supplier_id: 10, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Pasteurized skim milk, live active cultures." },
    { item_id: 31, item_name: "Dark Chocolate Bar 70%", brand: "Rhine Valley", upc: "812345000318", supplier_id: 11, country_of_origin: "Germany", mtl_neq_usa: 1, ingredients_statement: "Cocoa mass, cane sugar, cocoa butter, sunflower lecithin, vanilla." },
    { item_id: 32, item_name: "Milk Chocolate Hazelnut Bar", brand: "Rhine Valley", upc: "812345000325", supplier_id: 11, country_of_origin: "Germany", mtl_neq_usa: 1, ingredients_statement: "Cane sugar, cocoa butter, whole milk powder, hazelnuts, cocoa mass, soy lecithin, vanilla." },
    { item_id: 33, item_name: "Cocoa Powder Unsweetened", brand: "Rhine Valley", upc: "812345000332", supplier_id: 11, country_of_origin: "Germany", mtl_neq_usa: 1, ingredients_statement: "Cocoa powder." },
    { item_id: 34, item_name: "Turmeric Ground 4oz", brand: "Kerala Gold", upc: "812345000349", supplier_id: 12, country_of_origin: "India", mtl_neq_usa: 1, ingredients_statement: "Ground turmeric." },
    { item_id: 35, item_name: "Garam Masala Blend", brand: "Kerala Gold", upc: "812345000356", supplier_id: 12, country_of_origin: "India", mtl_neq_usa: 1, ingredients_statement: "Coriander, cumin, black pepper, cardamom, cinnamon, cloves, nutmeg." },
    { item_id: 36, item_name: "Basmati Rice 5lb", brand: "Kerala Gold", upc: "812345000363", supplier_id: 12, country_of_origin: "India", mtl_neq_usa: 1, ingredients_statement: "Basmati rice." },
    { item_id: 37, item_name: "Whole Wheat Sandwich Bread", brand: "SnackRight", upc: "812345000370", supplier_id: 4, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Whole wheat flour, water, yeast, honey, soybean oil, salt." },
    { item_id: 38, item_name: "Sourdough Baguette", brand: "SnackRight", upc: "812345000387", supplier_id: 4, country_of_origin: "United States of America", mtl_neq_usa: 0, ingredients_statement: "Wheat flour, water, sourdough starter, salt." },
    { item_id: 39, item_name: "Sesame Ginger Dressing", brand: "HarvestPlate", upc: "812345000394", supplier_id: 2, country_of_origin: "Japan", mtl_neq_usa: 1, ingredients_statement: "Soybean oil, rice vinegar, soy sauce (water, soybeans, wheat, salt), sesame seeds, ginger, cane sugar." },
    { item_id: 40, item_name: "Roasted Seaweed Snack 10ct", brand: "HarvestPlate", upc: "812345000400", supplier_id: 2, country_of_origin: "South Korea", mtl_neq_usa: 1, ingredients_statement: "Seaweed, sesame oil, sea salt." },
];

// Two retailer assortments that overlap but differ — scope isolation is
// visible in every query, not just the UC-01 one.
const RETAILER_100_ITEMS = [
    1, 2, 3, 4, 5, 6, 7, 9, 10, 11, // original R100 set (UC-01 answers depend on 4,5,6,7)
    16, 17, 18, 19, 20, 25, 26, 28, 29, 30, 31, 33, 34, 36, 37, 38,
];
const RETAILER_200_ITEMS = [
    5, 6, 8, 12, 13, 14, 15, // original R200 set (soy+China = 5,6)
    19, 21, 22, 23, 24, 27, 28, 32, 33, 35, 36, 39, 40,
];

const RETAILER_ITEMS = [
    ...RETAILER_100_ITEMS.map((item_id) => ({ retailer_id: "RETAILER_100", item_id })),
    ...RETAILER_200_ITEMS.map((item_id) => ({ retailer_id: "RETAILER_200", item_id })),
];

async function main() {
    // DDL/writes require the elevated credential; the bot never uses it.
    useAdminCredentials();
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

    // Guard the demo invariants: if a future edit breaks these, fail loudly.
    const check = await pool.request().query(`
        SELECT
            (SELECT COUNT(*) FROM sbs_test.items i JOIN sbs_test.retailer_items ri ON ri.item_id = i.item_id
             WHERE ri.retailer_id = 'RETAILER_100' AND i.ingredients_statement LIKE '%soy protein%'
               AND i.country_of_origin = 'China') AS uc01_soy_china_r100,
            (SELECT COUNT(*) FROM sbs_test.items i JOIN sbs_test.retailer_items ri ON ri.item_id = i.item_id
             WHERE ri.retailer_id = 'RETAILER_100' AND i.ingredients_statement LIKE '%wheat%'
               AND i.country_of_origin = 'China') AS uc01_wheat_china_r100,
            (SELECT COUNT(*) FROM sbs_test.items i JOIN sbs_test.retailer_items ri ON ri.item_id = i.item_id
             WHERE ri.retailer_id = 'RETAILER_200' AND i.ingredients_statement LIKE '%soy protein%'
               AND i.country_of_origin = 'China') AS soy_china_r200
    `);
    const c = check.recordset[0];
    console.log("Demo invariants:", JSON.stringify(c));
    if (c.uc01_soy_china_r100 !== 3 || c.uc01_wheat_china_r100 !== 1 || c.soy_china_r200 !== 2) {
        throw new Error("DEMO INVARIANT BROKEN — expected soy/China/R100=3, wheat/China/R100=1, soy/China/R200=2");
    }
    console.log("Demo invariants OK (3 / 1 / 2).");

    await closePool();
}

main().catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
});

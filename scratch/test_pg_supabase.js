const { createClient } = require('f:\\Work\\tools auto social\\socialflow\\api\\src\\lib\\pg-supabase.js');
require('dotenv').config();

const supabase = createClient(process.env.DATABASE_URL);

(async () => {
  try {
    console.log('Querying campaign details via pg-supabase mock client...');
    const res = await supabase
      .from('campaigns')
      .select('*, campaign_roles(*)')
      .eq('name', 'Tino');
    
    console.log('\n--- Result from pg-supabase ---');
    console.log(JSON.stringify(res, null, 2));

  } catch (err) {
    console.error('Error during pg-supabase test:', err);
  } finally {
    // pg-supabase exposes _pool
    if (supabase._pool) {
      await supabase._pool.end();
    }
  }
})();

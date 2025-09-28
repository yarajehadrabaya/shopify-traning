// shopify-audit.js
console.log('Starting Shopify Audit Script...');
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');

/**
 * Shopify Variant and SEO Audit Tool
 * 
 * This script audits Shopify products for missing variant weights and SEO titles,
 * and provides optional fixes using Admin GraphQL API with cursor pagination.
 * 
 * Features:
 * - Dry run mode (default) for analysis only
 * - Apply mode for actual updates (limited to 10 variants and 5 products)
 * - CSV export with detailed report
 * - Metafield support for default weight values
 * - REST API fallback for weight data
 */

class ShopifyVariantAudit {
    constructor() {
        // Load configuration from environment variables
        this.shop = process.env.SHOPIFY_STORE_DOMAIN;
        this.token = process.env.SHOPIFY_ACCESS_TOKEN;
        this.weightNamespace = process.env.WEIGHT_METAFIELD_NAMESPACE || 'custom';
        this.weightKey = process.env.WEIGHT_METAFIELD_KEY || 'default_weight';
        this.defaultWeight = parseFloat(process.env.DEFAULT_WEIGHT) || 1.0;
        this.isApplyMode = process.argv.includes('--apply');
        
        // API configuration
        this.baseUrl = `https://${this.shop}/admin/api/2023-10/graphql.json`;
        this.headers = {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.token
        };
        
        // Results storage
        this.results = [];
        this.updateSummary = {
            updated: 0,
            failed: 0,
            skipped: 0,
            variantsUpdated: [],
            productsUpdated: [],
            errors: []
        };
    }

    /**
     * Execute GraphQL query against Shopify Admin API
     */
    async fetchGraphQL(query, variables = {}) {
        try {
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({ query, variables })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.errors) {
                console.log('GraphQL Errors:', JSON.stringify(data.errors, null, 2));
                throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
            }
            
            return data.data;
        } catch (error) {
            console.error('GraphQL request failed:', error.message);
            throw error;
        }
    }

    /**
     * Fetch variant weight using REST API (fallback when GraphQL doesn't work)
     */
    async fetchVariantWeightREST(variantId) {
        try {
            const response = await fetch(
                `https://${this.shop}/admin/api/2023-10/variants/${variantId}.json`,
                {
                    headers: {
                        'X-Shopify-Access-Token': this.token,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            return data.variant;
        } catch (error) {
            console.log(`Cannot fetch weight via REST for variant ${variantId}: ${error.message}`);
            return { weight: null, weight_unit: null };
        }
    }

    /**
     * Get default weight from product metafield if available
     */
    async getWeightFromMetafield(productId) {
        const query = `
            query GetProductMetafields($id: ID!) {
                product(id: $id) {
                    metafields(namespace: "${this.weightNamespace}", first: 10) {
                        edges {
                            node {
                                key
                                value
                            }
                        }
                    }
                }
            }
        `;
        
        try {
            const data = await this.fetchGraphQL(query, { id: productId });
            if (data.product.metafields.edges.length > 0) {
                const weightMeta = data.product.metafields.edges.find(
                    edge => edge.node.key === this.weightKey
                );
                if (weightMeta) {
                    return parseFloat(weightMeta.node.value) || this.defaultWeight;
                }
            }
        } catch (error) {
            console.log(`Cannot fetch metafield for product ${this.extractId(productId)}`);
        }
        
        return this.defaultWeight;
    }

    /**
     * GraphQL query to fetch products with cursor-based pagination
     */
    getProductsQuery(after = null) {
        return `
            query GetProducts($after: String) {
                products(first: 10, after: $after) {
                    pageInfo {
                        hasNextPage
                        hasPreviousPage
                    }
                    edges {
                        cursor
                        node {
                            id
                            handle
                            title
                            seo {
                                title
                            }
                            variants(first: 20) {
                                edges {
                                    node {
                                        id
                                        title
                                        sku
                                        selectedOptions {
                                            name
                                            value
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;
    }

    /**
     * Fetch all products using cursor pagination
     */
    async getAllProducts() {
        let allProducts = [];
        let hasNextPage = true;
        let afterCursor = null;

        console.log('Fetching products...');

        while (hasNextPage) {
            try {
                const data = await this.fetchGraphQL(this.getProductsQuery(afterCursor));
                
                if (!data || !data.products) {
                    console.log('No products data returned');
                    break;
                }
                
                const products = data.products.edges;

                for (const edge of products) {
                    const product = edge.node;
                    allProducts.push(product);
                }

                hasNextPage = data.products.pageInfo.hasNextPage;
                afterCursor = products[products.length - 1]?.cursor;

                console.log(`Fetched ${allProducts.length} products...`);
                
                // Limit for testing - remove for full scan
                if (allProducts.length >= 20) {
                    console.log('Stopping at 20 products for testing');
                    break;
                }
                
            } catch (error) {
                console.error('Error fetching products:', error.message);
                break;
            }
        }

        return allProducts;
    }

    /**
     * Analyze a single product and its variants
     */
    async analyzeProduct(product) {
        const results = [];
        const seoTitle = product.seo?.title || '';
        const hasSeoTitle = seoTitle.trim().length > 0;

        // Get default weight from product metafield
        const defaultWeightFromMeta = await this.getWeightFromMetafield(product.id);

        for (const variantEdge of product.variants.edges) {
            const variant = variantEdge.node;
            
            // Fetch weight using REST API
            const variantData = await this.fetchVariantWeightREST(this.extractId(variant.id));
            const hasWeight = variantData.weight !== null && variantData.weight !== undefined;
            const needsWeightUpdate = !hasWeight;
            
            // Generate suggested SEO title
            let suggestedSeoTitle = 'OK';
            if (!hasSeoTitle) {
                suggestedSeoTitle = `${product.title} | ${product.handle}`;
            }

            results.push({
                productId: this.extractId(product.id),
                handle: product.handle,
                title: product.title,
                variantId: this.extractId(variant.id),
                variantTitle: variant.title || 'Default',
                sku: variant.sku || 'N/A',
                currentVariantWeight: hasWeight ? 
                    `${variantData.weight} ${variantData.weight_unit || 'g'}` : 'MISSING',
                suggestedVariantWeight: needsWeightUpdate ? 
                    `${defaultWeightFromMeta} kg` : 'OK',
                currentSeoTitle: seoTitle || 'EMPTY',
                suggestedSeoTitle: suggestedSeoTitle,
                needsWeightUpdate,
                needsSeoUpdate: !hasSeoTitle,
                hasWeightData: hasWeight
            });
        }

        return results;
    }

    /**
     * Extract ID from Shopify Global ID format
     */
    extractId(gid) {
        return gid.split('/').pop();
    }

    /**
     * Update variant weight using REST API
     */
    async updateVariantWeight(variantId, weight, weightUnit = 'kg') {
        if (!this.isApplyMode) {
            return { success: true, skipped: true, message: 'Dry run - no update performed' };
        }

        try {
            const response = await fetch(
                `https://${this.shop}/admin/api/2023-10/variants/${variantId}.json`,
                {
                    method: 'PUT',
                    headers: {
                        'X-Shopify-Access-Token': this.token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        variant: {
                            id: variantId,
                            weight: weight,
                            weight_unit: weightUnit
                        }
                    })
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return { success: true, message: 'Variant weight updated successfully' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Update product SEO title using GraphQL mutation
     */
    async updateProductSeo(productId, seoTitle) {
        if (!this.isApplyMode) {
            return { success: true, skipped: true, message: 'Dry run - no update performed' };
        }

        try {
            const mutation = `
                mutation productUpdate($input: ProductInput!) {
                    productUpdate(input: $input) {
                        product {
                            id
                            seo {
                                title
                            }
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `;

            const variables = {
                input: {
                    id: productId,
                    seo: {
                        title: seoTitle.substring(0, 255) // Limit to allowed length
                    }
                }
            };

            const data = await this.fetchGraphQL(mutation, variables);
            
            if (data.productUpdate.userErrors.length > 0) {
                const errors = data.productUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join(', ');
                return { success: false, message: errors };
            }

            return { success: true, message: 'Product SEO updated successfully' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Process and track update results
     */
    processUpdateResult(result, type, id) {
        if (result.success) {
            if (!result.skipped) {
                this.updateSummary.updated++;
                if (type === 'variant') {
                    this.updateSummary.variantsUpdated.push(id);
                } else {
                    this.updateSummary.productsUpdated.push(id);
                }
                console.log(`Success - ${type} ${id} updated successfully`);
            } else {
                this.updateSummary.skipped++;
                console.log(`Skipped - ${type} ${id} (dry run mode)`);
            }
        } else {
            this.updateSummary.failed++;
            this.updateSummary.errors.push(`${type} ${id}: ${result.message}`);
            console.log(`Failed - ${type} ${id}: ${result.message}`);
        }
    }

    /**
     * Apply updates to variants and products (limited to 10 variants and 5 products)
     */
    async applyUpdates() {
        console.log('Applying updates...');
        
        // Filter items needing updates
        const variantsToUpdate = this.results.filter(r => r.needsWeightUpdate);
        const productsToUpdate = this.results
            .filter(r => r.needsSeoUpdate)
            .filter((r, index, self) => 
                self.findIndex(item => item.productId === r.productId) === index
            );

        // Update variants (max 10)
        const variantsSample = variantsToUpdate.slice(0, 10);
        console.log(`Updating ${variantsSample.length} variants out of ${variantsToUpdate.length} needing weight updates`);
        
        for (const variant of variantsSample) {
            console.log(`Updating variant ${variant.variantId}...`);
            
            const weightMatch = variant.suggestedVariantWeight.match(/([\d.]+)\s*(\w+)/);
            if (weightMatch) {
                const result = await this.updateVariantWeight(
                    variant.variantId, 
                    parseFloat(weightMatch[1]), 
                    weightMatch[2]
                );
                
                this.processUpdateResult(result, 'variant', variant.variantId);
            } else {
                this.updateSummary.skipped++;
                console.log(`Skipping variant ${variant.variantId} - invalid weight format`);
            }
        }

        // Update products (max 5)
        const productsSample = productsToUpdate.slice(0, 5);
        console.log(`Updating ${productsSample.length} products out of ${productsToUpdate.length} needing SEO updates`);
        
        for (const product of productsSample) {
            console.log(`Updating product ${product.productId}...`);
            
            const result = await this.updateProductSeo(product.productId, product.suggestedSeoTitle);
            this.processUpdateResult(result, 'product', product.productId);
        }
    }

    /**
     * Export results to CSV file
     */
    exportToCSV() {
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = `shopify-audit-report-${timestamp}.csv`;
        
        const headers = 'Product ID,Handle,Product Title,Variant ID,Variant Title,SKU,Current Weight,Suggested Weight,Current SEO Title,Suggested SEO Title,Needs Weight Update,Needs SEO Update\n';
        
        let csvContent = headers;
        
        this.results.forEach(item => {
            const row = [
                item.productId,
                `"${item.handle}"`,
                `"${item.title.replace(/"/g, '""')}"`,
                item.variantId,
                `"${item.variantTitle.replace(/"/g, '""')}"`,
                `"${item.sku}"`,
                `"${item.currentVariantWeight}"`,
                `"${item.suggestedVariantWeight}"`,
                `"${item.currentSeoTitle.replace(/"/g, '""')}"`,
                `"${item.suggestedSeoTitle.replace(/"/g, '""')}"`,
                item.needsWeightUpdate ? 'YES' : 'NO',
                item.needsSeoUpdate ? 'YES' : 'NO'
            ].join(',');
            
            csvContent += row + '\n';
        });
        
        fs.writeFileSync(filename, csvContent, 'utf8');
        console.log(`Report created: ${filename}`);
        return filename;
    }

    /**
     * Main execution function
     */
    async run() {
        console.log(`Starting audit in ${this.isApplyMode ? 'APPLY' : 'DRY RUN'} mode...`);
        
        try {
            const products = await this.getAllProducts();
            console.log(`Total products found: ${products.length}`);

            if (products.length === 0) {
                console.log('No products found');
                return;
            }

            // Analyze each product
            let processedCount = 0;
            for (const product of products) {
                processedCount++;
                console.log(`Analyzing product ${processedCount}/${products.length}: ${product.title.substring(0, 50)}...`);
                
                const productResults = await this.analyzeProduct(product);
                this.results.push(...productResults);
            }

            console.log(`Analysis complete. Total variants analyzed: ${this.results.length}`);
            
            // Export report
            const reportFile = this.exportToCSV();
            
            // Apply updates if in apply mode
            if (this.isApplyMode) {
                await this.applyUpdates();
            }
            
            // Print summary
            this.printSummary(reportFile);

        } catch (error) {
            console.error('Audit failed:', error);
        }
    }

    /**
     * Print comprehensive summary of audit results
     */
    printSummary(reportFile) {
        console.log('\n=== AUDIT SUMMARY ===');
        console.log(`Products analyzed: ${[...new Set(this.results.map(r => r.productId))].length}`);
        console.log(`Variants analyzed: ${this.results.length}`);
        
        const variantsNeedingWeight = this.results.filter(r => r.needsWeightUpdate).length;
        const productsNeedingSeo = [...new Set(this.results.filter(r => r.needsSeoUpdate).map(r => r.productId))].length;
        
        console.log(`Variants needing weight updates: ${variantsNeedingWeight}`);
        console.log(`Products needing SEO updates: ${productsNeedingSeo}`);
        
        if (this.isApplyMode) {
            console.log('\n=== UPDATE SUMMARY ===');
            console.log(`Successfully updated: ${this.updateSummary.updated}`);
            console.log(`Failed updates: ${this.updateSummary.failed}`);
            console.log(`Skipped updates: ${this.updateSummary.skipped}`);
            
            if (this.updateSummary.variantsUpdated.length > 0) {
                console.log(`Variants updated: ${this.updateSummary.variantsUpdated.length}`);
            }
            if (this.updateSummary.productsUpdated.length > 0) {
                console.log(`Products updated: ${this.updateSummary.productsUpdated.length}`);
            }
            
            if (this.updateSummary.errors.length > 0) {
                console.log('\nErrors encountered:');
                this.updateSummary.errors.forEach(error => console.log(`- ${error}`));
            }
        } else {
            console.log('\nTo apply actual updates, run:');
            console.log('npm run apply');
            console.log('or');
            console.log('node index.js --apply');
            console.log('\nNote: Will update maximum 10 variants and 5 products');
        }
        
        console.log(`\nReport saved to: ${reportFile}`);
    }
}

// Main function
async function main() {
    console.log('Shopify Variant & SEO Audit Tool');
    console.log('================================\n');
    
    // Test connection first
    console.log('Testing Shopify store connection...');
    const shop = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!shop || !token) {
        console.error('Error: SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN not set in .env file');
        return;
    }

    try {
        const response = await fetch(`https://${shop}/admin/api/2023-10/shop.json`, {
            headers: {
                'X-Shopify-Access-Token': token
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log('Connection successful!');
            console.log('Store name:', data.shop.name);
            console.log('Email:', data.shop.email);
            console.log('================================\n');
            
            const audit = new ShopifyVariantAudit();
            await audit.run();
            
            console.log('\n================================');
            console.log('Audit completed successfully!');
        } else {
            console.error(`Connection failed: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('Connection error:', error.message);
    }
}

// Run the program
main().catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
});
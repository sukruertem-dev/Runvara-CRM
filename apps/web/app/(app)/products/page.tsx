'use client';

import { EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from '@flexa/ui';
import { PlugZap } from 'lucide-react';
import { useApp } from '../../../lib/app-context';
import { t } from '../../../lib/i18n';
import { PageContainer } from '../../_components/app-shell';
import { PriceLists } from './_parts/price-lists';
import { Products } from './_parts/products';
import { Rates } from './_parts/rates';

// Products and prices (B2B-03, docs/p8-plan.md §5). Everyone with the CRM module reads; Admin writes (Matrix A17).

export default function ProductsPage() {
  const { nav, can } = useApp();
  if (!nav) return null;
  if (!nav.menu.some((m) => m.id === 'products')) {
    return (
      <PageContainer>
        <h1 className="sr-only">{t('cat.title')}</h1>
        <EmptyState icon={PlugZap} title={t('settings.moduleOff')} description={t('settings.moduleOffBody')} />
      </PageContainer>
    );
  }
  const products = can('catalog.product.manage');
  const prices = can('catalog.price_list.manage');
  return (
    <PageContainer wide>
      <h1 className="m-0 mb-4 font-display text-xl font-bold">{t('cat.title')}</h1>
      {products || prices ? null : <p className="m-0 mb-4 rounded-card border border-line bg-subtle px-3 py-2 text-sm text-fg-muted" data-testid="cat-readonly">{t('cat.readOnly')}</p>}
      <Tabs defaultValue="products">
        <TabsList label={t('cat.title')} className="mb-4 overflow-x-auto">
          <TabsTrigger value="products">{t('cat.tab.products')}</TabsTrigger>
          <TabsTrigger value="lists">{t('cat.tab.lists')}</TabsTrigger>
          <TabsTrigger value="rates">{t('cat.tab.rates')}</TabsTrigger>
        </TabsList>
        <TabsContent value="products"><Products canWrite={products} /></TabsContent>
        <TabsContent value="lists"><PriceLists canWrite={prices} /></TabsContent>
        <TabsContent value="rates"><Rates canTax={products} canFx={prices} /></TabsContent>
      </Tabs>
    </PageContainer>
  );
}

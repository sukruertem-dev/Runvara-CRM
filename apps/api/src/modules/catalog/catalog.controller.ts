import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  FxRate, FxRateKey, PriceListCreate, PriceListItemSet, PriceListItemsQuery, PriceListPatch, PriceResolveRequest, ProductCreate, ProductListQuery, ProductPatch, TaxRateCreate, TaxRatePatch, type z,
} from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { CatalogService } from './catalog.service';
import { PricingService } from './pricing.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class CatalogController {
  constructor(private readonly svc: CatalogService, private readonly pricing: PricingService) {}

  // tax rates
  @Get('tax-rates')
  taxRates(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listTaxRates(t);
  }

  @Post('tax-rates')
  createTaxRate(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TaxRateCreate)) body: z.infer<typeof TaxRateCreate>, @Client() c: ClientInfo) {
    return this.svc.createTaxRate(t, body, c.ip);
  }

  @Patch('tax-rates/:id')
  patchTaxRate(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(TaxRatePatch)) body: z.infer<typeof TaxRatePatch>, @Client() c: ClientInfo) {
    return this.svc.patchTaxRate(t, id, requireIfMatch(im), body, c.ip);
  }

  // products
  @Get('products')
  products(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(ProductListQuery)) q: z.infer<typeof ProductListQuery>) {
    return this.svc.listProducts(t, q);
  }

  @Post('products')
  createProduct(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ProductCreate)) body: z.infer<typeof ProductCreate>, @Client() c: ClientInfo) {
    return this.svc.createProduct(t, body, c.ip);
  }

  @Get('products/:id')
  product(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.getProduct(t, id);
  }

  @Patch('products/:id')
  patchProduct(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(ProductPatch)) body: z.infer<typeof ProductPatch>, @Client() c: ClientInfo) {
    return this.svc.patchProduct(t, id, requireIfMatch(im), body, c.ip);
  }

  // price lists
  @Get('price-lists')
  priceLists(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listPriceLists(t);
  }

  @Post('price-lists')
  createPriceList(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(PriceListCreate)) body: z.infer<typeof PriceListCreate>, @Client() c: ClientInfo) {
    return this.svc.createPriceList(t, body, c.ip);
  }

  @Patch('price-lists/:id')
  patchPriceList(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(PriceListPatch)) body: z.infer<typeof PriceListPatch>, @Client() c: ClientInfo) {
    return this.svc.patchPriceList(t, id, requireIfMatch(im), body, c.ip);
  }

  @Get('price-lists/:id/items')
  items(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Query(new ZodPipe(PriceListItemsQuery)) q: z.infer<typeof PriceListItemsQuery>) {
    return this.svc.listItems(t, id, q);
  }

  @Put('price-lists/:id/products/:productId')
  @HttpCode(204)
  async setItem(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('productId', Id) productId: string, @Body(new ZodPipe(PriceListItemSet)) body: z.infer<typeof PriceListItemSet>, @Client() c: ClientInfo): Promise<void> {
    await this.svc.setItem(t, id, productId, body, c.ip);
  }

  // exchange rates
  @Get('fx-rates')
  fx(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listFx(t);
  }

  @Put('fx-rates')
  @HttpCode(204)
  async setFx(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(FxRate)) body: z.infer<typeof FxRate>, @Client() c: ClientInfo): Promise<void> {
    await this.svc.setFx(t, body, c.ip);
  }

  @Delete('fx-rates')
  @HttpCode(204)
  async removeFx(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(FxRateKey)) key: z.infer<typeof FxRateKey>, @Client() c: ClientInfo): Promise<void> {
    await this.svc.removeFx(t, key, c.ip);
  }

  // price resolution
  @Post('prices/resolve')
  @HttpCode(200)
  resolve(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(PriceResolveRequest)) body: z.infer<typeof PriceResolveRequest>) {
    return this.pricing.resolve(t, body);
  }
}

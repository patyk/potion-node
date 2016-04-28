import {
	fromCamelCase,
	toCamelCase,
	pairsToObject,
	omap
} from './utils';


/* tslint:disable: variable-name */
let Reflect = (<any>window).Reflect;
/* tslint:enable: variable-name */

// Make sure Reflect API is available,
// else throw an error.
// See https://github.com/angular/angular/blob/60727c4d2ba1e4b0b9455c767d0ef152bcedc7c2/modules/angular2/src/core/util/decorators.ts#L243
(function checkReflect() {
	if (!(Reflect && Reflect.getMetadata)) {
		throw 'reflect-metadata shim is required when using potion-node library';
	}
})();


const POTION_METADATA_KEY = Symbol('potion');
const POTION_URI_METADATA_KEY = Symbol('potion:uri');


/**
 * @readonly decorator
 */

const READONLY_METADATA_KEY = Symbol('potion:readonly');
export function readonly(target, property) {
	let constructor = typeof target === 'function'
		? target
		: typeof target.constructor === 'function'
			? target.constructor
			: null;

	if (constructor === null) {
		// TODO: maybe throw an error here
		return;
	}

	Reflect.defineMetadata(
		READONLY_METADATA_KEY,
		Object.assign(Reflect.getOwnMetadata(READONLY_METADATA_KEY, constructor) || {}, {[property]: true}),
		constructor
	);
}


/**
 * Item cache
 */

export interface PotionItemCache<T extends Item> {
	get(key: string): T;
	put(key: string, item: T): T;
	remove(key: string): void;
}


export interface URLSearchParams {
	[key: string]: any;
}

export interface RequestOptions {
	method?: string;
	search?: URLSearchParams;
	data?: any;
	cache?: boolean;
}

export interface FetchOptions extends RequestOptions {
	paginate?: boolean;
}

export interface PaginationOptions {
	page?: number;
	perPage?: number;
}

export interface QueryOptions extends PaginationOptions {
	where?: any;
	sort?: any;
}

export interface ItemOptions {
	'readonly'?: string[];
}


/**
 * Item
 */

export interface ItemConstructor {
	new (object: any): Item;
	store?: Store<Item>;
}

export abstract class Item {
	static store: Store<any>;

	private _id = null;
	private _uri: string;

	get id() {
		return this._id;
	}
	set id(id) {
		this._id = id;
	}

	get uri() {
		return this._uri;
	}
	set uri(uri) {
		this._uri = uri;
	}

	static fetch(id, {cache = true}: FetchOptions = {}): Promise<Item> {
		return this.store.fetch(id, {cache});
	}

	static query(queryOptions?: QueryOptions, {paginate = false, cache = true}: FetchOptions = {}): Promise<Item[] | Pagination<Item>> {
		return this.store.query(queryOptions, {paginate, cache});
	}

	constructor(properties: any = {}) {
		Object.assign(this, properties);
	}

	save(): Promise<Item> {
		return (<typeof Item>this.constructor).store.save(this.toJSON());
	}

	update(properties: any = {}): Promise<Item> {
		return (<typeof Item>this.constructor).store.update(this, properties);
	}

	destroy(): Promise<Item> {
		return (<typeof Item>this.constructor).store.destroy(this);
	}

	toJSON(): any {
		let properties = {};
		let metadata = Reflect.getOwnMetadata(READONLY_METADATA_KEY, this.constructor);

		Object
			.keys(this)
			.filter((key) => !key.startsWith('_') && (!metadata || (metadata && !metadata[key])))
			.forEach((key) => {
				properties[fromCamelCase(key)] = this[key];
			});

		return properties;
	}
}


export class Store<T extends Item> {
	cache: PotionItemCache<Item>;
	promise;

	private _itemConstructor: ItemConstructor;
	private _promises = [];

	constructor(itemConstructor: ItemConstructor) {
		this._itemConstructor = itemConstructor;

		let potion: PotionBase = Reflect.getOwnMetadata(POTION_METADATA_KEY, itemConstructor);

		this.promise = (<typeof PotionBase>potion.constructor).promise;
		this.cache = potion.cache;

	}

	fetch(id, {cache}: FetchOptions = {}): Promise<T> {
		let uri = `${Reflect.getOwnMetadata(POTION_URI_METADATA_KEY, this._itemConstructor)}/${id}`;

		// Try to get from cache
		if (cache && this.cache && this.cache.get) {
			let item = this.cache.get(uri);
			if (item) {
				return this.promise.resolve(item);
			}
		}

		// If we already asked for the resource,
		// return the exiting promise.
		let promise = this._promises[uri];
		if (promise) {
			return promise;
		}

		// Register a pending request,
		// get the data,
		// and parse it.
		// Enforce GET method
		promise = this._promises[uri] = Reflect
			.getOwnMetadata(POTION_METADATA_KEY, this._itemConstructor)
			.fetch(uri, {cache, method: 'GET'})
			.then(
				(item) => {
					// Remove pending request
					delete this._promises[uri];
					return item;
				},
				() => {
					// If request fails,
					// make sure to remove the pending request so further requests can be made.
					// Return is necessary.
					delete this._promises[uri];
					return this.promise.reject();
				}
			);

		return promise;
	}

	query(queryOptions?: QueryOptions, {paginate = false, cache = true}: FetchOptions = {}, paginationObj?: Pagination<T>): Promise<T[] | Pagination<T> | any> {
		return Reflect
			.getOwnMetadata(POTION_METADATA_KEY, this._itemConstructor)
			.fetch(
				Reflect.getOwnMetadata(POTION_URI_METADATA_KEY, this._itemConstructor),
				{
					paginate,
					cache,
					method: 'GET',
					search: queryOptions
				},
				paginationObj
			);
	}

	update(item: Item, data: any = {}): Promise<T> {
		return Reflect
			.getOwnMetadata(POTION_METADATA_KEY, this._itemConstructor)
			.fetch(item.uri, {data, cache: true, method: 'PATCH'});
	}

	save(data: any = {}): Promise<T> {
		return Reflect
			.getOwnMetadata(POTION_METADATA_KEY, this._itemConstructor)
			.fetch(Reflect.getOwnMetadata(POTION_URI_METADATA_KEY, this._itemConstructor), {data, cache: true, method: 'POST'});
	}

	destroy(item: Item): Promise<T> {
		let {uri} = item;

		return Reflect
			.getOwnMetadata(POTION_METADATA_KEY, this._itemConstructor)
			.fetch(uri, {method: 'DELETE'})
			.then(() => {
				// Clear the item from cache if exists
				if (this.cache && this.cache.get && this.cache.get(uri)) {
					this.cache.remove(uri);
				}
			});
	}
}


export function route<T>(uri: string, {method}: RequestOptions = {}): (params?: any, options?: FetchOptions) => Promise<T> {
	return function (params?: any, {paginate = false, cache = true}: FetchOptions = {}): any {
		let isCtor = typeof this === 'function';
		uri = `${isCtor ? Reflect.getOwnMetadata(POTION_URI_METADATA_KEY, this) : this.uri}${uri}`;

		let options: FetchOptions = {method, paginate, cache};
		if (method === 'GET') {
			options.search = params;
		} else if ((<any>['POST', 'PUT', 'PATCH']).includes(method)) {
			options.data = params;
		}

		return Reflect
			.getOwnMetadata(POTION_METADATA_KEY, isCtor ? this : this.constructor)
			.fetch(uri, options);
	};
}


/* tslint:disable: variable-name */
export let Route = {
	GET<T>(uri: string) {
		return route<T>(uri, {method: 'GET'});
	},
	DELETE<T>(uri: string) {
		return route<T>(uri, {method: 'DELETE'});
	},
	POST<T>(uri: string) {
		return route<T>(uri, {method: 'POST'});
	},
	PATCH<T>(uri: string) {
		return route<T>(uri, {method: 'PATCH'});
	},
	PUT<T>(uri: string) {
		return route<T>(uri, {method: 'PUT'});
	}
};
/* tslint:enable: variable-name */


export interface PotionOptions {
	prefix?: string;
	cache?: PotionItemCache<Item>;
}

export abstract class PotionBase {
	static promise = (<any>window).Promise;
	resources = {};
	cache: PotionItemCache<Item>;
	prefix: string;

	constructor({prefix = '', cache}: PotionOptions = {}) {
		this.prefix = prefix;
		this.cache = cache;
	}

	parseURI(uri: string) {
		uri = decodeURIComponent(uri);

		if (uri.indexOf(this.prefix) === 0) {
			uri = uri.substring(this.prefix.length);
		}

		for (let [resourceURI, resource] of (<any>Object).entries(this.resources)) {
			if (uri.indexOf(`${resourceURI}/`) === 0) {
				return {uri, resource, params: uri.substring(resourceURI.length + 1).split('/')};
			}
		}

		throw new Error(`Uninterpretable or unknown resource URI: ${uri}`);
	}

	protected abstract _fetch(uri, options?: RequestOptions): Promise<any>;

	fetch(uri, fetchOptions?: FetchOptions, paginationObj?: Pagination<any>): Promise<Item | Item[] | Pagination<Item> | any> {
		// Add the API prefix if not present
		let {prefix} = this;
		if (uri.indexOf(prefix) === -1) {
			uri = `${prefix}${uri}`;
		}

		fetchOptions = fetchOptions || {};

		if (fetchOptions.paginate) {
			// If no page was provided set to first
			// Default to 25 items per page
			fetchOptions.search = Object.assign({page: 1, perPage: 25}, fetchOptions.search);
		}

		return this
			// Convert camel case props to snake case
			// Note that only RequestOptions.search and RequestOptions.data need conversion,
			// but the rest of the props on RequestOptions are not affected anyway if conversion is applied on the whole object
			._fetch(uri, this._toPotionJSON(fetchOptions))
			.then(({data, headers}) => this._fromPotionJSON(data).then((json) => ({headers, data: json})))
			.then(({headers, data}) => {

				if (fetchOptions.paginate) {
					let count = headers['x-total-count'] || data.length;

					if (!paginationObj) {
						return new Pagination<Item>({uri, potion: this}, data, count, fetchOptions);
					} else {
						paginationObj.update(data, count);
					}
				}

				return data;
			});
	}

	register(uri: string, resource: any, options?: ItemOptions) {
		Reflect.defineMetadata(POTION_METADATA_KEY, this, resource);
		Reflect.defineMetadata(POTION_URI_METADATA_KEY, uri, resource);

		if (options && Array.isArray(options.readonly)) {
			options.readonly.forEach((property) => readonly(resource, property));
		}

		this.resources[uri] = resource;
		resource.store = new Store(resource);
	}

	registerAs(uri: string, options?: ItemOptions): ClassDecorator {
		return (target: any) => {
			this.register(uri, target, options);
			return target;
		};
	}

	private _toPotionJSON(json: any) {
		if (typeof json === 'object' && json !== null) {
			if (json instanceof Item && typeof json.uri === 'string') {
				return {$ref: `${this.prefix}${json.uri}`};
			} else if (json instanceof Date) {
				return {$date: json.getTime()};
			} else if (json instanceof Array) {
				return json.map((item) => this._toPotionJSON(item));
			} else {
				return omap(json, (key, value) => [fromCamelCase(key), this._toPotionJSON(value)]);
			}
		} else {
			return json;
		}
	}

	private _fromPotionJSON(json: any): Promise<any> {
		let {promise} = (<typeof PotionBase>this.constructor);
		if (typeof json === 'object' && json !== null) {
			if (json instanceof Array) {
				return promise.all(json.map((item) => this._fromPotionJSON(item)));
			} else if (typeof json.$uri === 'string') {
				let {resource, uri} = this.parseURI(json.$uri);
				let promises = [];

				for (let key of Object.keys(json)) {
					if (key === '$uri') {
						promises.push(promise.resolve([key, uri]));
					} else {
						promises.push(this._fromPotionJSON(json[key]).then((value) => [toCamelCase(key), value]));
					}
				}

				return promise
					.all(promises)
					.then((propertyValuePairs) => {
						let properties: any = pairsToObject(propertyValuePairs);
						let obj = {};

						Object
							.keys(properties)
							.filter((key) => key !== '$uri')
							.forEach((key) => obj[key] = properties[key]);

						let {params, uri} = this.parseURI(properties.$uri);
						Object.assign(obj, {uri, id: parseInt(params[0], 10)});

						let item = Reflect.construct(<any>resource, [obj]);
						if (this.cache && this.cache.put) {
							this.cache.put(uri, <any>item);
						}

						return item;
					});
			} else if (Object.keys(json).length === 1) {
				if (typeof json.$ref === 'string') {
					let {uri} = this.parseURI(json.$ref);

					// Try to get from cache
					if (this.cache && this.cache.get) {
						let item = this.cache.get(uri);
						if (item) {
							return promise.resolve(item);
						}
					}

					return this.fetch(uri);
				} else if (typeof json.$date !== 'undefined') {
					return promise.resolve(new Date(json.$date));
				}
			}

			let promises = [];

			for (let key of Object.keys(json)) {
				promises.push(this._fromPotionJSON(json[key]).then((value) => [toCamelCase(key), value]));
			}

			return promise
				.all(promises)
				.then((propertyValuePairs) => pairsToObject(propertyValuePairs));
		} else {
			return promise.resolve(json);
		}
	}
}


export class Pagination<T extends Item> implements Iterator<T> {
	get page() {
		return this._page;
	}
	set page(page) {
		this.changePageTo(page);
	}

	get perPage() {
		return this._perPage;
	}

	get pages() {
		return Math.ceil(this._total / this._perPage);
	}

	get total() {
		return this._total;
	}

	get length() {
		return this._items.length;
	}

	private _potion: PotionBase;
	private _uri: string;
	private _options: FetchOptions;

	private _pointer = 0;
	private _items: T[] = [];

	private _page: number;
	private _perPage: number;
	private _total: number;

	constructor({potion, uri}, items, count, options: FetchOptions) {
		this._potion = potion;
		this._uri = uri;
		this._options = options;

		this._items.push(...items);

		let {page, perPage} = options.search;
		this._page = page;
		this._perPage = perPage;
		this._total = parseInt(count, 10);
	}

	[Symbol.iterator](): IterableIterator<T> {
		return this;
	}

	next(): IteratorResult<T> {
		if (this._pointer < this._items.length) {
			return {
				done: false,
				value: this._items[this._pointer++]
			};
		} else {
			this._pointer = 0;
			return {
				done: true
			};
		}
	}

	changePageTo(page) {
		(<any>this._options.search).page = page;
		this._page = page;
		return this._potion.fetch(this._uri, this._options, this);
	}

	update(items, count) {
		this._items.splice(0, this.length, ...items);
		this._total = count;
	}

	toArray(): T[] {
		return this._items;
	}
}

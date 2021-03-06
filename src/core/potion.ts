/* tslint:disable:max-file-line-count */
import {
	decorateCtorWithPotionInstance,
	decorateCtorWithPotionURI,
	potionPromise,
	readonly
} from './metadata';
import {ItemOptions, Item} from './item';
import {Pagination, PaginationOptions} from './pagination';
import {
	MemCache,
	toCamelCase,
	mapToObject,
	toSnakeCase,
	omap,
	deepOmap,
	entries
} from '../utils';


/**
 * Item cache.
 * Dictates the implementation of the item cache.
 */
export interface ItemCache<T extends Item> {
	get(key: string): T;
	put(key: string, item: T): T;
	remove(key: string): void;
}


/**
 * Common interfaces.
 */

export interface ParsedURI {
	uri: string;
	resource: Item;
	params: string[];
}

export interface URLSearchParams {
	[key: string]: any;
}

export interface RequestOptions {
	method?: string;
	search?: URLSearchParams | undefined | null;
	data?: any;
	cache?: boolean;
}

export interface FetchOptions extends RequestOptions {
	paginate?: boolean;
}

export interface QueryOptions extends PaginationOptions {
	where?: any;
	sort?: any;
}

export interface PotionResponse {
	data: any;
	headers: any;
}


export interface PotionOptions {
	host?: string;
	prefix?: string;
	cache?: ItemCache<Item>;
}


/**
 * This class contains the main logic for interacting with the Flask Potion backend.
 * Note that this class does not contain the logic for making the HTTP requests,
 * it is up to the child class to implement the logic for that through the `request` method.
 * Furthermore, the child class also needs to provide the Promise class/fn as this class is set to use the native Promise only available from ES6.
 *
 * @example
 * class Potion extends PotionBase {
 *     protected request(uri, options?: RequestOptions): Promise<any> {
 *         // Here we need to implement the actual HTTP request
 *     };
 * }
 */
export abstract class PotionBase {
	readonly resources: {[key: string]: Item} = {};
	readonly cache: ItemCache<Item>;
	host: string;
	readonly prefix: string;

	private readonly Promise: typeof Promise = potionPromise(this); // NOTE: This is needed only to provide support for AngularJS.
	private pendingGETRequests: Map<string, any> = new Map();

	constructor({host = '', prefix = '', cache}: PotionOptions = {}) {
		this.cache = cache || new MemCache();
		this.host = host;
		this.prefix = prefix;
	}

	fetch(uri: string, fetchOptions?: FetchOptions, pagination?: Pagination<any>): Promise<Item | Item[] | Pagination<Item> | any> {
		const options: FetchOptions = {...fetchOptions};
		const {method, cache, paginate, data} = options;
		let {search} = options;
		const key = uri;
		const {Promise} = this;

		// Add the API prefix if not present
		const {prefix} = this;
		if (uri.indexOf(prefix) === -1) {
			uri = `${prefix}${uri}`;
		}

		if (paginate) {
			// If no page was provided set to first
			// Default to 25 items per page
			search = options.search = Object.assign({page: 1, perPage: 25}, search);
		}

		// Convert the {data, search} object props to snake case.
		// Serialize all values to Potion JSON.
		const fetch = () => this.request(`${this.host}${uri}`, {...options, ...{
				search: this.toPotionJSON(search),
				data: this.toPotionJSON(data)
			}})
			// Convert the data to Potion JSON
			.then((response) => this.deserialize(response))
			.then(({headers, data}) => {
				// Return or update Pagination
				if (paginate) {
					const count = headers['x-total-count'] || data.length;
					if (!pagination) {
						return new Pagination<Item>({uri, potion: this}, data, count, options);
					} else {
						return pagination.update(data, count);
					}
				}
				return data;
			});

		if (method === 'GET' && !search) {
			// If a GET request and {cache: true},
			// try to get item from cache,
			// and return a resolved promise with the cached item.
			// Note that queries are not cached.
			if  (cache) {
				const item = this.cache.get(key);
				if (item) {
					return Promise.resolve(item);
				}
			}

			// If we already asked for the resource,
			// return the exiting pending request promise.
			if (this.pendingGETRequests.has(uri)) {
				return this.pendingGETRequests.get(uri);
			}

			const request = fetch();
			// Save pending request
			this.pendingGETRequests.set(uri, request);

			return request.then((data) => {
				this.pendingGETRequests.delete(uri);
				return data;
			}, (err) => {
				// If request fails,
				// make sure to remove the pending request so further requests can be made.
				// Return is necessary.
				this.pendingGETRequests.delete(uri);
				const message = err instanceof Error
					? err.message
					: typeof err === 'string'
						? err
						: `An error occurred while Potion tried to retrieve a resource from '${uri}'.`;
				return Promise.reject(message);
				});
		} else {
			return fetch();
		}
	}

	/**
	 * Register a resource.
	 * @param {String} uri - Path on which the resource is registered.
	 * @param {Item} resource
	 * @param {ItemOptions} options - Set the property options for any instance of the resource (setting a property to readonly for instance).
	 */
	register(uri: string, resource: any, options?: ItemOptions): Item {
		decorateCtorWithPotionInstance(resource, this);
		decorateCtorWithPotionURI(resource, uri);

		if (options && Array.isArray(options.readonly)) {
			options.readonly.forEach((property) => readonly(resource, property));
		}
		this.resources[uri] = resource;

		return resource;
	}

	/**
	 * Register a resource.
	 * @param {String} uri - Path on which the resource is registered.
	 * @param {ItemOptions} options - Set the property options for any instance of the resource (setting a property to readonly for instance).
	 *
	 * @example
	 * @potion.registerAs('/user')
	 * class User extends Item {}
	 */
	registerAs(uri: string, options?: ItemOptions): ClassDecorator {
		return (target: any) => {
			this.register(uri, target, options);
			return target;
		};
	}

	/**
	 * Make a HTTP request.
	 * @param {string} uri
	 * @param {RequestOptions} options
	 * @returns {PotionResponse} An object with {data, headers} where {data} can be anything and {headers} is an object with the response headers from the HTTP request.
	 */
	protected abstract request(uri: string, options?: RequestOptions): Promise<PotionResponse>; // tslint:disable-line: prefer-function-over-method

	private parseURI(uri: string): ParsedURI {
		uri = decodeURIComponent(uri);

		if (uri.indexOf(this.prefix) === 0) {
			uri = uri.substring(this.prefix.length);
		}

		for (const [resourceURI, resource] of entries<string, any>(this.resources)) {
			if (uri.indexOf(`${resourceURI}/`) === 0) {
				return {
					uri,
					resource,
					params: uri.substring(resourceURI.length + 1)
						.split('/')
				};
			}
		}

		throw new Error(`URI '${uri}' is an uninterpretable or unknown potion resource.`);
	}

	private toPotionJSON(json: any): {[key: string]: any} {
		if (typeof json === 'object' && json !== null) {
			if (json instanceof Item && typeof json.uri === 'string') {
				return {$ref: `${this.prefix}${json.uri}`};
			} else if (json instanceof Date) {
				return {$date: json.getTime()};
			} else if (Array.isArray(json)) {
				return json.map((item) => this.toPotionJSON(item));
			} else {
				return omap(json, (key, value) => [toSnakeCase(key), this.toPotionJSON(value)]);
			}
		} else {
			return json;
		}
	}

	private deserialize({data, headers}: PotionResponse): Promise<PotionResponse> {
		return this.fromPotionJSON(data)
			.then((json) => ({
				headers,
				data: json
			}));
	}

	private fromPotionJSON(json: any): Promise<{[key: string]: any}> {
		const {Promise} = this;
		if (typeof json === 'object' && json !== null) {
			if (Array.isArray(json)) {
				return Promise.all(json.map((item) => this.fromPotionJSON(item)));
			} else if (typeof json.$uri === 'string') {
				// TODO: the json may also have {$type, $id} that can be used to recognize a resource
				// If neither combination is provided, it should throw and let the user now Flask Potion needs to be configured with one of these two strategies.

				// Try to parse the URI,
				// otherwise reject with the exception thrown from parseURI.
				let resource;
				let params;
				let uri;
				try {
					const parsedURI = this.parseURI(json.$uri);
					resource = parsedURI.resource;
					params = parsedURI.params;
					uri = parsedURI.uri;
				} catch (parseURIError) {
					return Promise.reject(parseURIError);
				}

				const properties: Map<string, any> = new Map();
				const promises: Map<string, Promise<any>> = new Map();

				// Cache the resource if it does not exist,
				// but do it before resolving any possible references (to other resources) on it.
				if (!this.cache.get(uri)) {
					this.cache.put(uri, Reflect.construct(resource, []));
				}

				// Resolve possible references
				for (const [key, value] of entries<string, any>(json)) {
					if (key === '$uri') {
						properties.set(key, uri);
					} else {
						const k = toCamelCase(key);
						promises.set(k, this.fromPotionJSON(value).then((value) => {
							properties.set(k, value);
							return value;
						}));
					}
				}

				// Set the id
				const [id] = params;
				properties.set('$id', Number.isInteger(id) || /^\d+$/.test(id) ? parseInt(id, 10) : id);

				return Promise.all(Array.from(promises.values()))
					.then(() => {
						// Try to get existing entry from cache
						let item = this.cache.get(uri);
						if (item) {
							// Update existing entry with new properties
							Object.assign(item, mapToObject(properties));
						} else {
							// Create a new entry
							item = Reflect.construct(resource, [mapToObject(properties)]);
							this.cache.put(uri, item);
						}

						return item;
					});
			} else if (typeof json.$schema === 'string') {
				// If we have a schema object,
				// we want to resolve it as it is and not try to resolve references or do any conversions.
				// Though, we want to convert snake case to camel case.
				return Promise.resolve(deepOmap(json, null, (key) => toCamelCase(key)));
			} else if (Object.keys(json).length === 1) {
				if (typeof json.$ref === 'string') {
					// Hack to not try to resolve self references.
					// TODO: Implement resolving self-references
					if (json.$ref === '#') {
						return Promise.resolve(json.$ref);
					}

					// Try to parse the URI,
					// otherwise reject with the exception thrown from parseURI.
					let uri;
					try {
						const parsedURI = this.parseURI(json.$ref);
						uri = parsedURI.uri;
					} catch (parseURIError) {
						return Promise.reject(parseURIError);
					}

					return this.fetch(uri, {
						cache: true,
						method: 'GET'
					});
				} else if (typeof json.$date !== 'undefined') {
					// Parse Potion date
					return Promise.resolve(new Date(json.$date));
				}
			}

			const properties: Map<string, any> = new Map();
			const promises: Map<string, Promise<any>> = new Map();

			for (const [key, value] of entries<string, any>(json)) {
				const k = toCamelCase(key);
				promises.set(k, this.fromPotionJSON(value).then((value) => {
					properties.set(k, value);
					return value;
				}));
			}

			return Promise.all(Array.from(promises.values()))
				.then(() => mapToObject(properties));
		} else {
			return Promise.resolve(json);
		}
	}
}

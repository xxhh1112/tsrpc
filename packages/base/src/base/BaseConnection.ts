import { TSBuffer } from "tsbuffer";
import { Chalk } from "../models/Chalk";
import { Counter } from "../models/Counter";
import { EventEmitter } from "../models/EventEmitter";
import { Flow } from "../models/Flow";
import { Logger, LogLevel } from "../models/Logger";
import { OpResult } from "../models/OpResult";
import { ServiceMap } from "../models/ServiceMapUtil";
import { TransportOptions } from "../models/TransportOptions";
import { ApiReturn } from "../proto/ApiReturn";
import { BaseServiceType } from "../proto/BaseServiceType";
import { ProtoInfo, TsrpcErrorType } from "../proto/TransportDataSchema";
import { TsrpcError } from "../proto/TsrpcError";
import { ApiCall } from "./ApiCall";
import { BaseConnectionFlows } from "./BaseConnectionFlows";
import { BoxBuffer, BoxTextDecoding, BoxTextEncoding, TransportData } from "./TransportData";
import { TransportDataUtil } from "./TransportDataUtil";

export const PROMISE_ABORTED = new Promise<any>(rs => { });

/**
 * BaseConnection
 * - Server have many BaseConnections
 *   - Http/Ws/Udp Connection
 * - Client is a BaseConnection
 *   - Http/Ws/Udp Client
 */
export abstract class BaseConnection<ServiceType extends BaseServiceType = any> {

    declare ServiceType: ServiceType;

    // Options
    get logger() { return this.options.logger };
    get chalk() { return this.options.chalk };

    // Status
    protected abstract _status: ConnectionStatus;

    /**
     * {@link Flow} to process `callApi`, `sendMsg`, buffer input/output, etc...
     * Server: all shared server flows
     * Client: independent flows
     */
    abstract flows: BaseConnectionFlows<this, ServiceType>;

    protected _remoteProtoInfo?: ProtoInfo;

    constructor(
        // Server: all connections shared single options
        public options: BaseConnectionOptions,
        public readonly serviceMap: ServiceMap,
        public readonly tsbuffer: TSBuffer,
        protected readonly _localProtoInfo: ProtoInfo
    ) {
        this._setDefaultFlowOnError();
    }

    // #region API Client

    protected _callApiSn = new Counter(1);
    protected _pendingCallApis = new Map<number, PendingApiItem>;

    get lastSn() {
        return this._callApiSn.last;
    }

    protected get _nextSn() {
        return this._callApiSn.getNext(true);
    }

    /**
     * Send request and wait for the return
     * @param apiName
     * @param req - Request body
     * @param options - Transport options
     * @returns return a `ApiReturn`, all error (network error, business error, code exception...) is unified as `TsrpcError`.
     * The promise is never rejected, so you just need to process all error in one place.
     */
    async callApi<T extends string & keyof ServiceType['api']>(apiName: T, req: ServiceType['api'][T]['req'], options?: TransportOptions): Promise<ApiReturn<ServiceType['api'][T]['res']>> {
        // SN & Log
        let sn = this._callApiSn.getNext();
        this.options.logApi && this.logger.log(`[CallApi] [#${sn}] ${this.chalk('[Req]', ['info'])} ${this.chalk(`[${apiName}]`, ['gray'])}`, this.options.logReqBody ? req : '');

        // Create PendingApiItem
        let pendingItem: PendingApiItem = {
            sn,
            apiName,
            req,
            abortKey: options?.abortKey,
            abortSignal: options?.abortSignal,
        };
        this._pendingCallApis.set(sn, pendingItem);

        // AbortSignal
        if (options?.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
                this.abort(sn);
            })
        }

        // PreCall Flow
        let preCall = await this.flows.preCallApiFlow.exec({ apiName, req, conn: this }, this.logger);
        if (!preCall || pendingItem.isAborted) {
            this.abort(pendingItem.sn);
            return PROMISE_ABORTED;
        }

        // Get Return
        let ret = preCall.ret ?? await this._doCallApi(preCall.apiName, preCall.req, pendingItem, options);

        // Aborted, skip return.
        if (pendingItem.isAborted) {
            return PROMISE_ABORTED;
        }

        // PreReturn Flow (before return)
        let preReturn = await this.flows.preCallApiReturnFlow.exec({
            ...preCall,
            return: ret
        }, this.logger);
        if (!preReturn || pendingItem.isAborted) {
            this.abort(pendingItem.sn);
            return PROMISE_ABORTED;
        }
        ret = preReturn.return;

        // Log Return
        if (this.options.logApi) {
            if (ret.isSucc) {
                this.logger.log(`[CallApi] [#${pendingItem.sn}] ${this.chalk('[Res]', ['info'])} ${this.chalk(`[${apiName}]`, ['gray'])}`, this.options.logResBody ? ret.res : '');
            }
            else {
                this.logger[ret.err.type === TsrpcError.Type.ApiError ? 'log' : 'error'](`[CallApi] [#${pendingItem.sn}] ${this.chalk('[Err]', [TsrpcError.Type.ApiError ? 'warn' : 'error'])} ${this.chalk(`[${apiName}]`, ['gray'])}`, ret.err);
            }
        }

        this._pendingCallApis.delete(pendingItem.sn);
        return ret;
    }

    protected async _doCallApi<T extends string & keyof ServiceType['api']>(serviceName: T, req: ServiceType['api'][T]['req'], pendingItem: PendingApiItem, options?: TransportOptions): Promise<ApiReturn<ServiceType['api'][T]['res']>> {
        // Make TransportData
        let transportData: TransportData = {
            type: 'req',
            serviceName,
            sn: this._nextSn,
            body: req
        }
        // Exchange Proto Info
        if (!this._remoteProtoInfo) {
            transportData.protoInfo = this._localProtoInfo;
        }

        // Send & Recv
        let promiseSend = this._sendTransportData(transportData, options);
        let promiseReturn = this._waitApiReturn(pendingItem, options?.timeout ?? this.options.callApiTimeout);

        // Encode or Send Error
        let opSend = await promiseSend;
        if (!opSend.isSucc) {
            return {
                isSucc: false,
                err: new TsrpcError(opSend.errMsg, { type: TsrpcErrorType.LocalError })
            };
        }

        // Wait ApiReturn
        let ret = await promiseReturn;
        return pendingItem.isAborted ? PROMISE_ABORTED : ret;
    }

    /**
     * @param sn 
     * @param timeout 
     * @returns `undefined` 代表 canceled
     */
    protected async _waitApiReturn(pendingItem: PendingApiItem, timeout?: number): Promise<ApiReturn<any>> {
        return new Promise<ApiReturn<any>>(rs => {
            // Timeout
            let timer: ReturnType<typeof setTimeout> | undefined;

            if (timeout) {
                timer = setTimeout(() => {
                    timer = undefined;
                    this._pendingCallApis.delete(pendingItem.sn);
                    rs({
                        isSucc: false,
                        err: new TsrpcError('Request Timeout', {
                            type: TsrpcErrorType.NetworkError,
                            code: 'TIMEOUT'
                        })
                    })
                }, timeout);
            }

            // Listener (trigger by `this._onRecvBuf`)
            pendingItem.onReturn = ret => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                this._pendingCallApis.delete(pendingItem.sn);
                rs(ret);
            }
        });
    }

    protected async _recvApiReturn(transportData: TransportData & { type: 'res' | 'err' }) {
        // Parse PendingApiItem
        const item = this._pendingCallApis.get(transportData.sn);
        if (!item) {
            this.logger.error('Invalid SN for callApi return: ' + transportData.sn, transportData);
            return;
        }
        if (item.isAborted) {
            return;
        }

        // Pre Flow
        let pre = await this.flows.preCallApiReturnFlow.exec({
            apiName: item.apiName,
            req: item.req,
            return: transportData.type === 'res' ? { isSucc: true, res: transportData.body } : { isSucc: false, err: transportData.err },
            conn: this
        }, this.logger);
        if (!pre || item.isAborted) {
            return;
        }

        item.onReturn?.(pre.return)
    }

    /**
     * Abort a pending API request, it makes the promise returned by `callApi()` neither resolved nor rejected forever.
     * @param sn - Every api request has a unique `sn` number, you can get it by `this.lastSN` 
     */
    abort(sn: number): void {
        // Find and Clear
        let pendingItem = this._pendingCallApis.get(sn);
        if (!pendingItem) {
            return;
        }
        this._pendingCallApis.delete(sn);

        // Log
        this.options.logApi && this.logger.log(`[CallApi] [#${pendingItem.sn}] ${this.chalk('[Abort]', ['info'])} ${this.chalk(`[${pendingItem.apiName}]`, ['gray'])}`);

        // onAbort
        pendingItem.onReturn = undefined;
        pendingItem.isAborted = true;
        pendingItem.onAbort?.();
    }
    /**
     * Abort all API requests that has the `abortKey`.
     * It makes the promise returned by `callApi` neither resolved nor rejected forever.
     * @param abortKey - The `abortKey` of options when `callApi()`, see {@link TransportOptions.abortKey}.
     * @example
     * ```ts
     * // Send API request many times
     * client.callApi('SendData', { data: 'AAA' }, { abortKey: 'Session#123' });
     * client.callApi('SendData', { data: 'BBB' }, { abortKey: 'Session#123' });
     * client.callApi('SendData', { data: 'CCC' }, { abortKey: 'Session#123' });
     *
     * // And abort the at once
     * client.abortByKey('Session#123');
     * ```
     */
    abortByKey(abortKey: string) {
        this._pendingCallApis.forEach(v => {
            if (v.abortKey === abortKey) {
                this.abort(v.sn)
            }
        })
    }
    /**
     * Abort all pending API requests.
     * It makes the promise returned by `callApi` neither resolved nor rejected forever.
     */
    abortAll() {
        this._pendingCallApis.forEach(v => this.abort(v.sn));
    }
    // #endregion

    // #region API Server

    protected _apiHandlers: Record<string, ApiHandler<this> | undefined> = {};

    /**
     * Associate a `ApiHandler` to a specific `apiName`.
     * So that when `ApiCall` is receiving, it can be handled correctly.
     * @param apiName
     * @param handler
     */
    implementApi<Api extends string & keyof ServiceType['api']>(apiName: Api, handler: ApiHandler<any>): void {
        if (this._apiHandlers[apiName as string]) {
            throw new Error('implementApi duplicately for: ' + apiName);
        }
        this._apiHandlers[apiName as string] = handler;
        this.logger.log(`API implemented succ: ${this.chalk(apiName, ['underline'])}`);
    };

    protected async _recvApiReq(transportData: TransportData & { type: 'req' }): Promise<ApiReturn<any>> {
        // Make ApiCall
        const call = new ApiCall(this, transportData.serviceName, transportData.sn, transportData.body, transportData.protoInfo);
        return call.execute();
    }

    protected _setDefaultFlowOnError() {
        // API Flow Error: return "Remote internal error"
        this.flows.preApiCallFlow.onError = (e, call) => {
            call['_internalError'](e)
        };
        this.flows.preApiCallReturnFlow.onError = (e, call) => {
            if (!call.return) {
                call['_internalError'](e)
            }
            else {
                call.logger.error('postApiCallFlow Error:', e);
            }
        };
    }

    // #endregion

    // #region Message

    protected _msgListeners = new EventEmitter<{ [K in keyof ServiceType['msg']]: [ServiceType['msg'][K], K, this] }>();

    /**
     * Send message, without response, not ensuring the server is received and processed correctly.
     * @param msgName
     * @param msg - Message body
     * @param options - Transport options
     * @returns If the promise is resolved, it means the request is sent to system kernel successfully.
     * Notice that not means the server received and processed the message correctly.
     */
    async sendMsg<T extends string & keyof ServiceType['msg']>(msgName: T, msg: ServiceType['msg'][T], options?: TransportOptions): Promise<OpResult<void>> {
        // Pre Flow
        let pre = await this.flows.preSendMsgFlow.exec({
            msgName: msgName,
            msg: msg,
            conn: this
        }, this.logger);
        if (!pre) {
            return PROMISE_ABORTED;
        }
        msgName = pre.msgName as any;
        msg = pre.msg as any;

        // Encode & Send
        let opResult = await this._sendTransportData({
            type: 'msg',
            serviceName: msgName,
            body: msg
        }, options)

        // Log
        if (opResult.isSucc) {
            this.options.logMsg && this.logger.log(`[SendMsg]`, msgName, msg);
        }
        else {
            this.logger.error(`[SendMsgErr] [${msgName}] XXXXXXXX`, msg);
        }

        return opResult;
    }

    protected async _recvMsg(transportData: TransportData & { type: 'msg' }) {
        // PreRecv Flow
        let pre = await this.flows.preRecvMsgFlow.exec({
            conn: this,
            msgName: transportData.serviceName,
            msg: transportData.body as ServiceType['msg'][keyof ServiceType['msg']]
        }, this.logger);
        if (!pre) {
            return;
        }

        // MsgHandlers
        this._msgListeners.emit(transportData.serviceName, transportData.body as ServiceType['msg'][string & keyof ServiceType['msg']], transportData.serviceName, this);
    }

    /**
     * Add a message handler,
     * duplicate handlers to the same `msgName` would be ignored.
     * @param msgName
     * @param handler
     * @returns
     */
    onMsg<T extends string & keyof ServiceType['msg'], U extends MsgHandler<this, T>>(msgName: T | RegExp, handler: U, context?: any): U {
        if (msgName instanceof RegExp) {
            Object.keys(this.serviceMap.msgName2Service).filter(k => msgName.test(k)).forEach(k => {
                this._msgListeners.on(k as T, handler, context)
            })
            return handler;
        }
        else {
            return this._msgListeners.on(msgName, handler, context)
        }
    }

    onceMsg<T extends string & keyof ServiceType['msg']>(msgName: T, handler: MsgHandler<this, T>, context?: any): MsgHandler<this, T> {
        return this._msgListeners.once(msgName, handler, context);
    };

    /**
     * Remove a message handler
     */
    offMsg<T extends string & keyof ServiceType['msg']>(msgName: T | RegExp): void;
    offMsg<T extends string & keyof ServiceType['msg']>(msgName: T | RegExp, handler: Function, context?: any): void;
    offMsg<T extends string & keyof ServiceType['msg']>(msgName: T | RegExp, handler?: Function, context?: any) {
        if (msgName instanceof RegExp) {
            Object.keys(this.serviceMap.msgName2Service).filter(k => msgName.test(k)).forEach(k => {
                handler ? this._msgListeners.off(k, handler, context) : this._msgListeners.off(k)
            })
        }
        else {
            handler ? this._msgListeners.off(msgName, handler, context) : this._msgListeners.off(msgName)
        }
    }

    // #endregion

    // #region Transport

    // #region Encode options (may override by HTTP Text)
    protected _encodeJsonStr?: ((obj: any, schemaId: string) => string);
    protected _encodeSkipSN?: boolean;
    protected _encodeBoxText?: (typeof TransportDataUtil)['encodeBoxText'];
    protected _decodeBoxText?: (typeof TransportDataUtil)['decodeBoxText'];
    // #endregion

    /**
     * Achieved by the implemented Connection.
     * @param transportData Type haven't been checked, need to be done inside.
     */
    protected async _sendTransportData(transportData: TransportData, options?: TransportOptions): Promise<OpResult<void>> {
        if (this._status !== ConnectionStatus.Opened) {
            return { isSucc: false, errMsg: `Connection status is not "opened", cannot send any data.` }
        }

        const dataType = options?.dataType ?? this.options.dataType;

        // Encode body
        const opEncodeBody = dataType === 'buffer'
            ? TransportDataUtil.encodeBodyBuffer(transportData, this.serviceMap, this.tsbuffer, this.options.skipEncodeValidate)
            : TransportDataUtil.encodeBodyText(transportData, this.serviceMap, this.tsbuffer, this.options.skipEncodeValidate, this._encodeJsonStr);
        if (!opEncodeBody.isSucc) { return opEncodeBody }

        // Encode box
        const opEncodeBox = dataType === 'buffer'
            ? TransportDataUtil.encodeBoxBuffer(opEncodeBody.res as BoxBuffer)
            : (this._encodeBoxText ?? TransportDataUtil.encodeBoxText)(opEncodeBody.res as BoxTextEncoding, this._encodeSkipSN)
        if (!opEncodeBox.isSucc) { return opEncodeBox }

        // Pre Flow
        const pre = await this.flows.preSendDataFlow.exec({
            conn: this,
            data: opEncodeBox.res,
            transportData: transportData
        }, this.logger);
        if (!pre) {
            return PROMISE_ABORTED;
        }

        // Do Send
        return this._sendData(pre.data, transportData, options);
    }

    /**
     * Encode and send
     * @param transportData Type has been checked already
     */
    protected abstract _sendData(data: string | Uint8Array, transportData: TransportData, options?: TransportOptions): Promise<OpResult<void>>;

    /**
     * Called by the implemented Connection.
     * @param transportData Type haven't been checked, need to be done inside.
     */
    protected async _recvTransportData(transportData: TransportData): Promise<void> {
        // Sync remote protoInfo
        if ('protoInfo' in transportData && transportData.protoInfo) {
            this._remoteProtoInfo = transportData.protoInfo;
        }

        switch (transportData.type) {
            case 'req': {
                this._recvApiReq(transportData);
                break;
            }
            case 'res':
            case 'err': {
                this._recvApiReturn(transportData);
                break;
            }
            case 'msg': {
                this._recvMsg(transportData)
                break;
            }
            case 'heartbeat': {
                // TODO
                // this.heartbeatManager.recv(heartbeatSn)
                break;
            }

        }
    };

    protected async _recvData(data: string | Uint8Array, meta?: any): Promise<void> {
        // Ignore all data if connection is not opened
        if (this._status !== ConnectionStatus.Opened) {
            return;
        }

        // Pre Flow
        const pre = await this.flows.preRecvDataFlow.exec({
            conn: this,
            data: data
        }, this.logger);
        if (!pre) {
            this.logger.debug('[preRecvDataFlow] Canceled', data);
            return;
        }
        // Decode by preFlow
        if (pre.parsedTransportData) {
            return this._recvTransportData(pre.parsedTransportData);
        }
        data = pre.data;

        // Decode box
        const opDecodeBox = typeof data === 'string'
            ? (this._decodeBoxText ?? TransportDataUtil.decodeBoxText)(data, this._pendingCallApis, this.options.skipDecodeValidate)
            : TransportDataUtil.decodeBoxBuffer(data, this._pendingCallApis, this.serviceMap, this.options.skipDecodeValidate);
        if (!opDecodeBox.isSucc) {
            this.logger.error(`[DecodeBoxErr] Received data:`, data);
            this.logger.error(`[DecodeBoxErr] ${opDecodeBox.errMsg}`);
            return;
        }

        // Decode body
        const opDecodeBody = typeof data === 'string'
            ? TransportDataUtil.decodeBodyText(opDecodeBox.res as BoxTextDecoding, this.serviceMap, this.tsbuffer, this.options.skipDecodeValidate)
            : TransportDataUtil.decodeBodyBuffer(opDecodeBox.res as BoxBuffer, this.serviceMap, this.tsbuffer, this.options.skipDecodeValidate)
        if (!opDecodeBody.isSucc) {
            this.logger.error(`[DecodeBodyErr] Received body:`, opDecodeBox.res);
            this.logger.error(`[DecodeBodyErr] ${opDecodeBody.errMsg}`);
            return;
        }

        this._recvTransportData(opDecodeBody.res);
    };

    // #endregion
}

export const defaultBaseConnectionOptions: BaseConnectionOptions = {
    logger: {
        debug: console.debug.bind(console),
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    }
} as any

/**
 * Server: all connections shared 1 options
 * Client: each is independent options
 */
export interface BaseConnectionOptions {
    dataType: 'text' | 'buffer',
    apiReturnInnerError: boolean,

    // Log
    logger: Logger,
    logLevel: LogLevel,
    chalk: Chalk,
    logApi: boolean,
    logMsg: boolean,
    logReqBody: boolean,
    logResBody: boolean,
    debugBuf: boolean,

    // Timeout
    callApiTimeout: number,
    apiCallTimeout: number,

    // Runtime Type Check
    skipEncodeValidate: boolean;
    skipDecodeValidate: boolean;

    // Heartbeat
    heartbeat?: {
        sendInterval: number,
        recvTimeout: number
    },

    // Serialization (Only for HTTP)
    // encodeReturnText?: (ret: ApiReturn<any>) => string,
    // decodeReturnText?: (data: string) => ApiReturn<any>,

    // jsonEncoder: any;
    // jsonDecoder: any;
    // bufferEncoder: any;
    // bufferDecoder: any;
}

export interface PendingApiItem {
    sn: number,
    apiName: string,
    req: any,
    isAborted?: boolean,
    abortKey?: string,
    abortSignal?: AbortSignal,
    onAbort?: () => void,
    onReturn?: (ret: ApiReturn<any>) => void
}

export type ApiHandler<Conn extends BaseConnection> = <T extends Conn>(call: ApiCall<any, any, T>) => (void | Promise<void>);
export type MsgHandler<Conn extends BaseConnection, MsgName extends keyof Conn['ServiceType']['msg']>
    = <T extends Conn>(msg: T['ServiceType']['msg'][MsgName], msgName: MsgName, conn: T) => void | Promise<void>;

export enum ConnectionStatus {
    Opening = 'Opening',
    Opened = 'Opened',
    Closing = 'Closing',
    Closed = 'Closed',
}

export interface IHeartbeatManager {
    // TODO
    // TCP / UDP 机制不同
}
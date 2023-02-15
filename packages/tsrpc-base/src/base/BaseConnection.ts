import { TSBuffer } from 'tsbuffer';
import { Chalk } from '../models/Chalk';
import { Counter } from '../models/Counter';
import { EventEmitter } from '../models/EventEmitter';
import { Flow } from '../models/Flow';
import { Logger } from '../models/Logger';
import { MsgHandlerUtil } from '../models/MsgHandlerUtil';
import { OpResultVoid } from '../models/OpResult';
import { ServiceMap } from '../models/ServiceMapUtil';
import { TransportOptions } from '../models/TransportOptions';
import { ApiReturn } from '../proto/ApiReturn';
import { BaseServiceType } from '../proto/BaseServiceType';
import { ProtoInfo, TsrpcErrorType } from '../proto/TransportDataSchema';
import { TsrpcError } from '../proto/TsrpcError';
import { ApiCall } from './ApiCall';
import { BaseConnectionFlows } from './BaseConnectionFlows';
import {
  BoxBuffer,
  BoxDecoding,
  BoxEncoding,
  BoxTextDecoding,
  BoxTextEncoding,
  TransportData,
} from './TransportData';
import { TransportDataUtil } from './TransportDataUtil';

export const PROMISE_ABORTED = new Promise<any>((rs) => {});

/**
 * BaseConnection
 * - Server have many BaseConnections
 *   - Http/Ws/Udp Connection
 * - Client is a BaseConnection
 *   - Http/Ws/Udp Client
 */
export abstract class BaseConnection<
  ServiceType extends BaseServiceType = any
> {
  declare $ServiceType: ServiceType;

  /** Which side this connection is belong to */
  abstract side: 'server' | 'client';

  get connName() {
    return this.side === 'server' ? 'connection' : 'client';
  }

  // Options
  logger: Logger;
  chalk: Chalk;
  public readonly serviceMap: ServiceMap;
  public readonly tsbuffer: TSBuffer;
  protected readonly _localProtoInfo: ProtoInfo;

  // Status
  private _status: ConnectionStatus = ConnectionStatus.Disconnected;
  public get status(): ConnectionStatus {
    return this._status;
  }
  protected set status(newStatus: ConnectionStatus) {
    if (this.status === newStatus) {
      return;
    }
    this._status = newStatus;

    // Post Connect
    if (newStatus === ConnectionStatus.Connected) {
      this.options.heartbeat && this._startHeartbeat();
      this.flows.postConnectFlow.exec(this, this.logger);
    }
  }

  protected _disconnecting?: Promise<OpResultVoid>;
  protected async _disconnect(
    isManual: boolean,
    reason?: string
  ): Promise<OpResultVoid> {
    if (this._disconnecting) {
      return this._disconnecting;
    }

    if (this.status === ConnectionStatus.Disconnected) {
      return { isSucc: true };
    }
    if (this._status !== ConnectionStatus.Connected) {
      return {
        isSucc: false,
        errMsg: `You can only call "disconnect" if the ${this.connName} status is "Connected" (the current status is "${this.status}")`,
      };
    }
    this._status = ConnectionStatus.Disconnecting;

    this._disconnecting = (async () => {
      this._stopHeartbeat();

      // 对所有请求中的 API 报错
      this._pendingCallApis.forEach((v) => {
        v.onReturn?.({
          isSucc: false,
          err: new TsrpcError(
            `Disconnected to server${reason ? `, reason: ${reason}` : ''}`,
            { type: TsrpcErrorType.NetworkError, code: 'LOST_CONN' }
          ),
        });
      });

      // Timeout 3s
      await Promise.race([
        this._doDisconnect(isManual, reason).then((v) => {
          if (!v.isSucc) {
            this.logger.debug('[DisconnectErr]', v.errMsg);
          }
        }),
        new Promise<void>((rs) => {
          setTimeout(() => {
            this.logger.debug('[DisconnectErr] _doDisconnect timeout');
            rs();
          }, 3000);
        }),
      ]);
      this._status = ConnectionStatus.Disconnected;

      if (this.options.logConnect) {
        if (this.side === 'client') {
          // Lost connection
          if (!isManual) {
            this.logger.warn(`[Disconnect] Lost connection to the server`);
          } else {
            this.logger.info('[Disconnect] Disconnected successfully');
          }
        } else {
          this.logger.info('[Disconnect] Connection disconnected');
        }
      }

      // Post Flow
      this.flows.postDisconnectFlow.exec(
        {
          conn: this,
          isManual,
          reason,
        },
        this.logger
      );

      return { isSucc: true };
    })();

    this._disconnecting
      .catch((e) => {})
      .then(() => {
        this._disconnecting = undefined;
      });

    return this._disconnecting;
  }
  // To be override
  protected abstract _doDisconnect(
    isManual: boolean,
    reason?: string
  ): Promise<OpResultVoid>;

  /**
   * {@link Flow} to process `callApi`, `sendMsg`, buffer input/output, etc...
   * Server: all shared server flows
   * Client: independent flows
   */
  flows: BaseConnectionFlows<this>;

  protected _remoteProtoInfo?: ProtoInfo;

  constructor(
    public dataType: BaseConnectionDataType,
    // Server: all connections shared single options
    public readonly options: BaseConnectionOptions,
    privateOptions: PrivateBaseConnectionOptions
  ) {
    this.flows = privateOptions.flows;
    this._setDefaultFlowOnError();
    this.logger = options.logger;
    this.chalk = options.chalk;
    this.serviceMap = privateOptions.serviceMap;
    this.tsbuffer = privateOptions.tsbuffer;
    this._localProtoInfo = privateOptions.localProtoInfo;
    this._apiHandlers = privateOptions.apiHandlers ?? {};
  }

  // #region API Client

  protected _callApiSn = new Counter(1);
  protected _pendingCallApis = new Map<number, PendingCallApiItem>();

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
  async callApi<T extends RemoteApiName<this>>(
    apiName: T,
    req: RemoteApi<this>[T]['req'],
    options?: TransportOptions
  ): Promise<ApiReturn<RemoteApi<this>[T]['res']>> {
    // SN & Log
    const sn = this._callApiSn.getNext();
    this.options.logApi &&
      this.logger.info(
        `${this.chalk(`[callApi] [#${sn}] [${apiName}]`, [
          'debug',
        ])} ${this.chalk('[Req]', ['info', 'bold'])}`,
        this.options.logReqBody ? req : ''
      );

    // Create PendingCallApiItem
    const pendingItem: PendingCallApiItem = {
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
      });
    }

    // PreCall Flow
    const preCall = await this.flows.preCallApiFlow.exec(
      { apiName, req, conn: this },
      this.logger
    );
    if (!preCall || pendingItem.isAborted) {
      this.abort(pendingItem.sn);
      return PROMISE_ABORTED;
    }

    // Get Return
    let ret =
      preCall.return ??
      (await this._doCallApi(
        preCall.apiName,
        preCall.req,
        pendingItem,
        options
      ));

    // Aborted, skip return.
    if (pendingItem.isAborted) {
      return PROMISE_ABORTED;
    }

    // PreReturn Flow (before return)
    const preReturn = await this.flows.preCallApiReturnFlow.exec(
      {
        ...preCall,
        return: ret,
      },
      this.logger
    );
    if (!preReturn || pendingItem.isAborted) {
      this.abort(pendingItem.sn);
      return PROMISE_ABORTED;
    }
    ret = preReturn.return;

    // Log Return
    if (this.options.logApi) {
      if (ret.isSucc) {
        this.logger.info(
          `${this.chalk(`[callApi] [#${pendingItem.sn}] [${apiName}]`, [
            'debug',
          ])} ${this.chalk('[Res]', ['info', 'bold'])}`,
          this.options.logResBody ? ret.res : ''
        );
      } else {
        this.logger[
          ret.err.type === TsrpcError.Type.ApiError ? 'info' : 'error'
        ](
          `${this.chalk(`[callApi] [#${pendingItem.sn}] [${apiName}]`, [
            'debug',
          ])} ${this.chalk('[Err]', [
            TsrpcError.Type.ApiError ? 'warn' : 'error',
            'bold',
          ])}`,
          ret.err
        );
      }
    }

    this._pendingCallApis.delete(pendingItem.sn);
    return ret;
  }

  protected async _doCallApi<T extends string & keyof RemoteApi<this>>(
    serviceName: T,
    req: RemoteApi<this>[T]['req'],
    pendingItem: PendingCallApiItem,
    options?: TransportOptions
  ): Promise<ApiReturn<RemoteApi<this>[T]['res']>> {
    // Make TransportData
    const transportData: TransportData = {
      type: 'req',
      serviceName,
      sn: pendingItem.sn,
      body: req,
    };
    // Exchange Proto Info
    if (!this._remoteProtoInfo) {
      transportData.protoInfo = this._localProtoInfo;
    }

    // Send & Recv
    const promiseSend = this._sendTransportData(transportData, options);
    const promiseReturn = this._waitApiReturn(
      pendingItem,
      options?.timeout ?? this.options.callApiTimeout
    );

    // Encode or Send Error
    const opSend = await promiseSend;
    if (!opSend.isSucc) {
      return {
        isSucc: false,
        err: new TsrpcError(opSend.errMsg, { type: TsrpcErrorType.LocalError }),
      };
    }

    // Wait ApiReturn
    const ret = await promiseReturn;
    return pendingItem.isAborted ? PROMISE_ABORTED : ret;
  }

  /**
   * @param sn
   * @param timeout
   * @returns `undefined` 代表 canceled
   */
  protected async _waitApiReturn(
    pendingItem: PendingCallApiItem,
    timeout?: number
  ): Promise<ApiReturn<any>> {
    return new Promise<ApiReturn<any>>((rs) => {
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
              code: 'TIMEOUT',
            }),
          });
        }, timeout);
      }

      // Listener (trigger by `this._onRecvBuf`)
      pendingItem.onReturn = (ret) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this._pendingCallApis.delete(pendingItem.sn);
        rs(ret);
      };
    });
  }

  protected async _recvApiReturn(
    transportData: TransportData & { type: 'res' | 'err' }
  ): Promise<void> {
    // err.sn===0 means this is a error that remote cannot decode the data
    if (transportData.type === 'err' && transportData.sn === 0) {
      this.logger.error(
        this.chalk(`[RemoteErr]`, ['error']),
        transportData.err,
        transportData.protoInfo
      );
      return;
    }

    // Parse PendingCallApiItem
    const item = this._pendingCallApis.get(transportData.sn);
    if (!item || item.isAborted) {
      return;
    }

    const apiReturn: ApiReturn<unknown> =
      transportData.type === 'res'
        ? { isSucc: true, res: transportData.body }
        : { isSucc: false, err: transportData.err };
    item.onReturn?.(apiReturn);
    return;
  }

  /**
   * Abort a pending API request, it makes the promise returned by `callApi()` neither resolved nor rejected forever.
   * @param sn - Every api request has a unique `sn` number, you can get it by `this.lastSN`
   */
  abort(sn: number): void {
    // Find and Clear
    const pendingItem = this._pendingCallApis.get(sn);
    if (!pendingItem) {
      return;
    }
    this._pendingCallApis.delete(sn);

    // Log
    this.options.logApi &&
      this.logger.info(
        `${this.chalk(
          `[callApi] [#${pendingItem.sn}] [${pendingItem.apiName}]`,
          ['debug']
        )} ${this.chalk('[Abort]', ['warn', 'bold'])}`
      );

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
    this._pendingCallApis.forEach((v) => {
      if (v.abortKey === abortKey) {
        this.abort(v.sn);
      }
    });
  }
  /**
   * Abort all pending API requests.
   * It makes the promise returned by `callApi` neither resolved nor rejected forever.
   */
  abortAll() {
    this._pendingCallApis.forEach((v) => this.abort(v.sn));
  }
  // #endregion

  // #region API Server

  protected _apiHandlers: Record<string, ApiHandler | undefined>;

  protected _recvApiReq(
    transportData: TransportData & { type: 'req' }
  ): Promise<ApiReturn<any>> {
    // Make ApiCall
    const call = new ApiCall(
      this,
      transportData.serviceName,
      transportData.sn,
      transportData.body,
      transportData.protoInfo
    );
    return call.execute();
  }

  protected _setDefaultFlowOnError() {
    // API Flow Error: return "Remote internal error"
    this.flows.preApiCallFlow.onError = (e, call) => {
      call['_internalError'](e);
    };
    this.flows.preApiCallReturnFlow.onError = (e, call) => {
      if (!call.return) {
        call['_internalError'](e);
      } else {
        call.logger.error('postApiCallFlow Error:', e);
      }
    };
  }

  // #endregion

  // #region Message

  protected _msgHandlers: MsgEmitter<this> = new EventEmitter();

  /**
   * Send message, without response, not ensuring the server is received and processed correctly.
   * @param msgName
   * @param msg - Message body
   * @param options - Transport options
   * @returns If the promise is resolved, it means the request is sent to system kernel successfully.
   * Notice that not means the server received and processed the message correctly.
   */
  async sendMsg<T extends string & keyof ServiceType['msg']>(
    msgName: T,
    msg: ServiceType['msg'][T],
    options?: TransportOptions
  ): Promise<OpResultVoid> {
    // Pre Flow
    const pre = await this.flows.preSendMsgFlow.exec(
      {
        msgName: msgName,
        msg: msg,
        conn: this,
      },
      this.logger
    );
    if (!pre) {
      return PROMISE_ABORTED;
    }
    msgName = pre.msgName as T;
    msg = pre.msg as ServiceType['msg'][T];

    // Encode & Send
    const opResult = await this._sendTransportData(
      {
        type: 'msg',
        serviceName: msgName,
        body: msg,
      },
      options
    );

    // Log
    if (opResult.isSucc) {
      this.options.logMsg && this.logger.info(`[SendMsg]`, msgName, msg);
    } else {
      this.logger.error(`[SendMsgErr] ${msgName} ${opResult.errMsg}`, msg);
    }

    // Post Flow
    this.flows.postSendMsgFlow.exec(
      {
        msgName: msgName,
        msg: msg,
        conn: this,
      },
      this.logger
    );

    return opResult;
  }

  /**
   * Custom alternative to `this._msgHandlers.emit`
   * For example, do something before or after `emit`
   */
  protected _emitMsg?: MsgEmitter<this>['emit'];
  protected async _recvMsg(
    transportData: TransportData & { type: 'msg' }
  ): Promise<void> {
    this.options.logMsg &&
      this.logger.info(
        `[RecvMsg]`,
        transportData.serviceName,
        transportData.body
      );

    // PreRecv Flow
    const pre = await this.flows.preRecvMsgFlow.exec(
      {
        conn: this,
        msgName: transportData.serviceName,
        msg: transportData.body as ServiceType['msg'][MsgName<this>],
      },
      this.logger
    );
    if (!pre) {
      return;
    }

    // MsgHandlers
    if (this._emitMsg) {
      this._emitMsg(
        transportData.serviceName,
        transportData.body as ServiceType['msg'][string &
          keyof ServiceType['msg']],
        transportData.serviceName,
        this
      );
    } else {
      this._msgHandlers.emit(
        transportData.serviceName,
        transportData.body as ServiceType['msg'][string &
          keyof ServiceType['msg']],
        transportData.serviceName,
        this
      );
    }
    return;
  }

  /**
   * Add a message handler,
   * duplicate handlers to the same `msgName` would be ignored.
   * @param msgName
   * @param handler
   * @returns
   */
  onMsg<
    T extends string & keyof ServiceType['msg'],
    U extends MsgHandler<this, T>
  >(msgName: T | RegExp, handler: U, context?: any): U {
    return MsgHandlerUtil.onMsg(
      this,
      this._msgHandlers,
      msgName,
      handler,
      context
    );
  }

  onceMsg<T extends string & keyof ServiceType['msg']>(
    msgName: T,
    handler: MsgHandler<this, T>,
    context?: any
  ): MsgHandler<this, T> {
    return MsgHandlerUtil.onceMsg(this._msgHandlers, msgName, handler, context);
  }

  /**
   * Remove a message handler
   */
  offMsg<T extends string & keyof ServiceType['msg']>(
    msgName: T | RegExp
  ): void;
  offMsg<T extends string & keyof ServiceType['msg']>(
    msgName: T | RegExp,
    handler: Function,
    context?: any
  ): void;
  offMsg<T extends string & keyof ServiceType['msg']>(
    msgName: T | RegExp,
    handler?: Function,
    context?: any
  ) {
    return MsgHandlerUtil.offMsg(
      this,
      this._msgHandlers,
      msgName,
      handler,
      context
    );
  }

  // #endregion

  // #region Transport

  // #region Encode options (may override by HTTP Text)
  protected _encodeSkipSN?: boolean;
  protected _stringifyBodyJson?: (
    bodyJson: Object,
    transportData: TransportData,
    schemaId: string
  ) => string;
  protected _encodeBoxText?: (typeof TransportDataUtil)['encodeBoxText'];
  protected _decodeBoxText?: (typeof TransportDataUtil)['decodeBoxText'];
  // #endregion

  /**
   * Achieved by the implemented Connection.
   * @param transportData Type haven't been checked, need to be done inside.
   */
  protected async _sendTransportData(
    transportData: TransportData,
    options?: TransportOptions,
    call?: ApiCall
  ): Promise<OpResultVoid> {
    if (this.options.debugBuf) {
      this.logger.debug('[debugBuf] [SendTransportData]', transportData);
    }
    if (this.status !== ConnectionStatus.Connected) {
      return this._errConnNotConnected();
    }

    const dataType = options?.dataType ?? this.dataType;

    // Encode body
    const opEncodeBody =
      dataType === 'buffer'
        ? TransportDataUtil.encodeBodyBuffer(
            transportData,
            this.serviceMap,
            this.tsbuffer,
            this.options.skipEncodeValidate
          )
        : TransportDataUtil.encodeBodyText(
            transportData,
            this.serviceMap,
            this.tsbuffer,
            this.options.skipEncodeValidate,
            this._stringifyBodyJson
          );
    if (!opEncodeBody.isSucc) {
      return opEncodeBody;
    }

    return this._sendBox(
      opEncodeBody.res,
      dataType,
      transportData,
      options,
      call
    );
  }

  protected async _sendBox(
    box: BoxEncoding,
    dataType: BaseConnectionDataType,
    transportData: TransportData,
    options?: TransportOptions,
    call?: ApiCall
  ): Promise<OpResultVoid> {
    if (this.options.debugBuf) {
      this.logger.debug('[debugBuf] [SendBox]', box);
    }

    // Encode box
    const opEncodeBox =
      dataType === 'buffer'
        ? TransportDataUtil.encodeBoxBuffer(
            box as BoxBuffer,
            this._encodeSkipSN
          )
        : (this._encodeBoxText ?? TransportDataUtil.encodeBoxText)(
            box as BoxTextEncoding,
            this._encodeSkipSN
          );
    if (!opEncodeBox.isSucc) {
      return opEncodeBox;
    }

    // Pre Flow
    const pre = await this.flows.preSendDataFlow.exec(
      {
        conn: this,
        data: opEncodeBox.res,
        transportData: transportData,
        call: call as (ApiCall<any, any, this> & { return: any }) | undefined,
      },
      this.logger
    );
    if (!pre) {
      return PROMISE_ABORTED;
    }

    // Send Data
    if (this.status !== ConnectionStatus.Connected) {
      return this._errConnNotConnected();
    }
    if (this.options.debugBuf) {
      this.logger.debug('[debugBuf] [SendData]', pre.data);
    }
    const opSend = await this._sendData(pre.data, transportData, options);

    // Post Flow
    if (opSend.isSucc) {
      this.flows.postSendDataFlow.exec(
        {
          conn: this,
          data: pre.data,
          transportData: transportData,
          call: call as (ApiCall<any, any, this> & { return: any }) | undefined,
        },
        this.logger
      );
    }

    return opSend;
  }

  protected abstract _errConnNotConnected(): OpResultVoid & { isSucc: false };

  /**
   * Encode and send
   * @param transportData Type has been checked already
   */
  protected abstract _sendData(
    data: string | Uint8Array,
    transportData: TransportData,
    options?: TransportOptions
  ): Promise<OpResultVoid>;

  /**
   * Called by the implemented Connection.
   * @param transportData Type haven't been checked, need to be done inside.
   */
  protected async _recvTransportData(
    transportData: TransportData
  ): Promise<void> {
    this.options.debugBuf &&
      this.logger.debug('[debugBuf] [RecvTransportData]', transportData);

    // Sync remote protoInfo
    if ('protoInfo' in transportData && transportData.protoInfo) {
      this._remoteProtoInfo = transportData.protoInfo;
    }

    switch (transportData.type) {
      case 'req': {
        this._recvApiReq(transportData);
        return;
      }
      case 'res':
      case 'err': {
        return this._recvApiReturn(transportData);
      }
      case 'msg': {
        return this._recvMsg(transportData);
      }
      case 'heartbeat': {
        return this._recvHeartbeat(transportData);
      }
      case 'custom': {
        return this._recvCustom?.(transportData);
      }
    }
  }

  /** Hook for custom data */
  protected _recvCustom?: (
    transportData: TransportData & { type: 'custom' }
  ) => void;

  /**
   * Decode raw data to `Box`, and then call `_recvBox`
   * @param data
   * @param decodeBoxOptions Will pass through to TransportUtil.decodeBoxText() and TransportUtil.decodeBoxBuffer()
   * @returns If a valid Box is decoded, return `isSucc: true`, otherwise return `isSucc: false`
   */
  protected async _recvData(
    data: string | Uint8Array,
    boxInfo?: Partial<BoxDecoding>
  ): Promise<OpResultVoid> {
    // Ignore all data if connection is not opened
    if (this.status !== ConnectionStatus.Connected) {
      return PROMISE_ABORTED;
    }

    this.options.debugBuf && this.logger.debug('[debugBuf] [RecvData]', data);

    // Pre Flow
    const pre = await this.flows.preRecvDataFlow.exec(
      {
        conn: this,
        data: data,
      },
      this.logger
    );
    if (!pre) {
      this.logger.debug('[preRecvDataFlow] Canceled', data);
      return PROMISE_ABORTED;
    }
    // Decode by preFlow
    if (pre.decodedData) {
      this._recvTransportData(pre.decodedData);
      return { isSucc: true };
    }
    data = pre.data;
    const dataType = typeof data === 'string' ? 'text' : 'buffer';

    // Decode box
    const opDecodeBox =
      typeof data === 'string'
        ? (this._decodeBoxText ?? TransportDataUtil.decodeBoxText)(
            data,
            this._pendingCallApis,
            this.options.skipDecodeValidate,
            boxInfo
          )
        : TransportDataUtil.decodeBoxBuffer(
            data,
            this._pendingCallApis,
            this.serviceMap,
            this.options.skipDecodeValidate,
            boxInfo
          );
    if (!opDecodeBox.isSucc) {
      this.logger.debug(
        `[RecvDataErr] dataType=${dataType}, length=${data.length}), data:`,
        data,
        'opDecodeBox:',
        opDecodeBox
      );

      // Log
      if (dataType === 'text' || opDecodeBox.errPhase === 'validate') {
        this.logger.error(
          `[RecvDataErr] Invalid data format. ${opDecodeBox.errMsg}`
        );
      } else {
        this.logger.error(`[RecvDataErr] Unknown buffer encoding, please check:
  1. Is the remote side using TSRPC version 3.x? (3.x can not communiate with 4.x) Try to upgrade and retry.
  2. Are you using Flow that modified the received data? Try to remove flows from both local and remote and retry.`);
      }

      // Send error with SN=0
      this._sendTransportData({
        type: 'err',
        sn: 0,
        err: new TsrpcError(opDecodeBox.errMsg, {
          type: TsrpcErrorType.RemoteError,
        }),
        protoInfo: this._localProtoInfo,
      });

      return { isSucc: false, errMsg: opDecodeBox.errMsg };
    }

    this._recvBox(opDecodeBox.res, dataType);
    return { isSucc: true };
  }

  /**
   * Decode box to `TransparentData`, and call `_recvTransparentData`
   * @param box
   * @param dataType
   * @returns If a valid `TransparentData` is decoded, return `isSucc: true`, otherwise return `isSucc: false`
   */
  protected async _recvBox(
    box: BoxDecoding,
    dataType: BaseConnectionDataType
  ): Promise<OpResultVoid> {
    this.options.debugBuf && this.logger.debug('[debugBuf] [RecvBox]', box);

    // Decode body
    const opDecodeBody =
      dataType === 'text'
        ? TransportDataUtil.decodeBodyText(
            box as BoxTextDecoding,
            this.serviceMap,
            this.tsbuffer,
            this.options.skipDecodeValidate
          )
        : TransportDataUtil.decodeBodyBuffer(
            box as BoxBuffer,
            this.serviceMap,
            this.tsbuffer,
            this.options.skipDecodeValidate
          );
    if (!opDecodeBody.isSucc) {
      // Only req res msg would fail
      this.options.debugBuf &&
        this.logger.debug(
          `[DecodeBodyErr] box:`,
          box,
          'errMsg:',
          opDecodeBody.errMsg
        );

      // If serviceProto not match, logger.error it
      let protoNotSyncedInfo: string | undefined;
      if ('protoInfo' in box && box.protoInfo) {
        const remoteProtoInfo = box.protoInfo as ProtoInfo;
        if (remoteProtoInfo.md5 !== this._localProtoInfo.md5) {
          const isLocalNewer =
            this._localProtoInfo.lastModified > remoteProtoInfo.lastModified;
          // Align log content by tail space
          const local = `Local${
            isLocalNewer
              ? this.chalk(' (newer)', ['info'])
              : this.chalk(' (outdated)', ['warn'])
          }`;
          const remote = `Remote${
            isLocalNewer
              ? this.chalk(' (outdated)', ['warn'])
              : this.chalk(' (newer)', ['info'])
          }`;
          const maxLength = Math.max(local.length, remote.length);
          const localTailSpace = ' '.repeat(maxLength - local.length);
          const remoteTailSpace = ' '.repeat(maxLength - remote.length);

          protoNotSyncedInfo = `  - ${local}${localTailSpace}  lastModified=${this.chalk(
            new Date(this._localProtoInfo.lastModified).format(),
            ['debug']
          )}  md5=${this._localProtoInfo.md5}
  - ${remote}${remoteTailSpace}  lastModified=${this.chalk(
            new Date(remoteProtoInfo.lastModified).format(),
            ['debug']
          )}  md5=${remoteProtoInfo.md5}`;
        }
      }

      // Log and return error reason
      let errReason: string, logReason: string;
      // Text (JSON) or errPhase==validate, errMsg is useful, log it.
      if (opDecodeBody.errPhase === 'validate') {
        errReason = opDecodeBody.errMsg;
        logReason = `Body type error. ${errReason}`;
      } else if (dataType === 'text') {
        errReason = opDecodeBody.errMsg;
        logReason = `${errReason}`;
      } else if (protoNotSyncedInfo) {
        errReason =
          'Cannot decode body from the data, because the serviceProto is different between the local and remote.';
        logReason = `${errReason}\n${protoNotSyncedInfo}`;
      }
      // Buffer && errPhase==decode, log a human readable message
      else {
        errReason =
          'Cannot decode body from the data, the box encoding is valid, but the body encoding is unknown.';
        logReason = `${errReason} please check:
  1. Is the serviceProto the same between the local and remote? (Check field 'md5')
  2. Is the buffer modified by Flow? Try to disable data flows and retry.`;
      }
      this.logger.error(this.chalk('[RecvDataErr] ', ['error']) + logReason);

      // req: send err
      if (box.type === 'req') {
        this._sendTransportData({
          type: 'err',
          sn: box.sn,
          err: new TsrpcError(errReason, {
            // TODO RemoteError 根据 side 决定
            type: TsrpcErrorType.RemoteError,
          }),
          protoInfo: this._localProtoInfo,
        });
      }
      // ret: transform to err
      else if (box.type === 'res') {
        this._recvTransportData({
          type: 'err',
          sn: box.sn,
          protoInfo: box.protoInfo,
          err: new TsrpcError(errReason, {
            type: TsrpcErrorType.LocalError,
          }),
        });
      }

      return { isSucc: false, errMsg: errReason };
    }

    this._recvTransportData(opDecodeBody.res);
    return { isSucc: true };
  }
  // #endregion

  //#region Heartbeat

  // ! Heartbeat 统一走可靠传输通道

  /**
   * Last latency time (ms) of heartbeat test
   */
  lastHeartbeatLatency = 0;

  protected _heartbeat?: {
    sn: Counter;
    sendTimer?: ReturnType<typeof setTimeout>;
    recvTimeout?: ReturnType<typeof setTimeout>;
    lastSendTime: number;
  };

  protected _startHeartbeat() {
    if (this._heartbeat) {
      return;
    }

    // Set interval and timers
    if (this.options.heartbeatSendInterval) {
      this._heartbeat = {
        sn: new Counter(),
        lastSendTime: 0,
      };
      this._sendHeartbeat();
    }

    // Init recv timeout
    this._resetHeartbeatTimeout();
  }

  protected _stopHeartbeat() {
    // Clear interval and timers
    if (this._heartbeat?.sendTimer) {
      clearTimeout(this._heartbeat.sendTimer);
    }
    if (this._heartbeat?.recvTimeout) {
      clearTimeout(this._heartbeat.recvTimeout);
    }

    this._heartbeat = undefined;
  }

  protected _sendHeartbeat() {
    if (!this._heartbeat) {
      return;
    }

    this._heartbeat.lastSendTime = performance.now();
    this._sendTransportData({
      type: 'heartbeat',
      sn: this._heartbeat!.sn.getNext(),
    });
  }

  private _recvHeartbeat(data: TransportData & { type: 'heartbeat' }) {
    if (!this._heartbeat) {
      return;
    }
    this._resetHeartbeatTimeout();

    // Recv Pong
    if (data.isReply) {
      // calculate lastHeartbeatLatency
      this.lastHeartbeatLatency =
        performance.now() - this._heartbeat.lastSendTime;

      // send again after interval
      if (this.options.heartbeatSendInterval) {
        this._heartbeat.sendTimer = setTimeout(() => {
          this._sendHeartbeat();
        }, this.options.heartbeatSendInterval);
      }
    }
    // Recv Ping
    else {
      // Send Pong
      this._sendTransportData({
        ...data,
        isReply: true,
      });
    }

    return;
  }

  private _resetHeartbeatTimeout() {
    if (!this._heartbeat) {
      return;
    }

    // Clear old
    if (this._heartbeat.recvTimeout) {
      clearTimeout(this._heartbeat.recvTimeout);
    }

    // Set new
    this._heartbeat.recvTimeout = setTimeout(() => {
      this._disconnect(false, 'Receive heartbeat timeout');
    }, this.options.heartbeatRecvTimeout);
  }
  //#endregion

  // #region Deprecated APIs
  // #endregion
}

export const defaultBaseConnectionOptions: BaseConnectionOptions = {
  // Log
  logger: console,
  chalk: (v) => v,
  logConnect: true,
  logApi: true,
  logMsg: true,
  logReqBody: true,
  logResBody: true,
  debugBuf: false,

  // Timeout
  callApiTimeout: 15000,
  apiCallTimeout: 15000,

  // ApiCall
  returnInnerError: true,

  // Runtime Type Check
  skipEncodeValidate: false,
  skipDecodeValidate: false,

  // Heartbeat
  heartbeat: true,
  heartbeatSendInterval: 1000,
  heartbeatRecvTimeout: 5000,

  // Serialization (Only for HTTP)
  // encodeReturnText?: (ret: ApiReturn<any>) => string,
  // decodeReturnText?: (data: string) => ApiReturn<any>,
};

/**
 * Server: all connections shared 1 options
 * Client: each is independent options
 */
export interface BaseConnectionOptions {
  // Log
  logger: Logger;
  chalk: Chalk;
  logConnect: boolean;
  logApi: boolean;
  logMsg: boolean;
  logReqBody: boolean;
  logResBody: boolean;
  debugBuf: boolean;

  // Timeout
  /** `0` represent no timeout */
  callApiTimeout: number;
  /** `0` represent no timeout */
  apiCallTimeout: number;

  // TSBufferOptions
  skipEncodeValidate: boolean;
  skipDecodeValidate: boolean;

  // ApiCall
  /**
   * When uncaught error throwed, whether to return the original error as a property `innerErr`.
   * @defaultValue true
   */
  returnInnerError: boolean;

  // Heartbeat
  /**
   * Whether enable heartbeat
   * @defaultValue true
   */
  heartbeat: boolean;
  /**
   * Interval time (ms) to send heartbeat packet.
   * Unit: ms
   * `0` represent not send heartbeat request.
   * At least 1 end needs to send a heartbeat between the local and the remote.
   * @defaultValue 1000
   */
  heartbeatSendInterval: number;
  /**
   * Timeout time (ms) to disconnect if not receive any heartbeat packet (ping or pong).
   * Unit: ms
   * @defaultValue 5000
   */
  heartbeatRecvTimeout: number;
}

export interface PendingCallApiItem {
  sn: number;
  apiName: string;
  req: any;
  isAborted?: boolean;
  abortKey?: string;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  onReturn?: (ret: ApiReturn<any>) => void;
}

export type ApiHandler<
  Conn extends BaseConnection = any,
  ApiName extends LocalApiName<Conn> = any
> = <T extends Conn>(
  call: ApiCall<
    LocalApi<Conn>[ApiName]['req'],
    LocalApi<Conn>[ApiName]['res'],
    T
  >
) => void | Promise<void>;
export type MsgHandler<
  Conn extends BaseConnection = any,
  MsgName extends keyof Conn['$ServiceType']['msg'] = any,
  MsgType extends Conn['$ServiceType']['msg'][MsgName] = Conn['$ServiceType']['msg'][MsgName]
> = <T extends Conn>(
  msg: MsgType,
  msgName: MsgName,
  conn: T
) => void | Promise<void>;

export enum ConnectionStatus {
  Connecting = 'Connecting',
  Connected = 'Connected',
  Disconnecting = 'Disconnecting',
  Disconnected = 'Disconnected',
}

/**
 * text: Transport as JSON string.
 * buffer: Transport as Buffer (serialized by tsbuffer).
 */
export type BaseConnectionDataType = 'text' | 'buffer';

export interface PrivateBaseConnectionOptions {
  flows: BaseConnectionFlows<any>;
  apiHandlers?: BaseConnectionApiHandlers;
  serviceMap: ServiceMap;
  tsbuffer: TSBuffer;
  localProtoInfo: ProtoInfo;
}

export type AutoImplementApiReturn = {
  succ: string[];
  fail: { apiName: string; errMsg: string }[];
  delay: string[];
};

export type LocalApi<T extends BaseConnection> = T['side'] extends 'client'
  ? T['$ServiceType']['clientApi']
  : T['$ServiceType']['api'];
export type RemoteApi<T extends BaseConnection> = T['side'] extends 'server'
  ? T['$ServiceType']['clientApi']
  : T['$ServiceType']['api'];
export type LocalApiName<T extends BaseConnection> = keyof LocalApi<T> & string;
export type RemoteApiName<T extends BaseConnection> = keyof RemoteApi<T> &
  string;
export type MsgName<T extends BaseConnection> = keyof T['$ServiceType']['msg'] &
  string;
export type BaseConnectionApiHandlers = Record<string, ApiHandler | undefined>;
export type MsgEmitter<Conn extends BaseConnection> = EventEmitter<{
  [K in keyof Conn['$ServiceType']['msg']]: [
    Conn['$ServiceType']['msg'][K],
    K,
    Conn
  ];
}>;

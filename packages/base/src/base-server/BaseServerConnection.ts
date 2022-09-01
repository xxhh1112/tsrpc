import { BaseConnection, BaseConnectionDataType, ConnectionStatus } from "../base/BaseConnection";
import { Logger } from "../models/Logger";
import { PrefixLogger } from "../models/PrefixLogger";
import { BaseServiceType } from "../proto/BaseServiceType";
import { BaseServer } from "./BaseServer";

export abstract class BaseServerConnection<ServiceType extends BaseServiceType = any> extends BaseConnection<ServiceType> {

    public readonly id: number;
    constructor(public readonly server: BaseServer, options: BaseServerConnectionOptions) {
        super(options.dataType, server.options, server.serviceMap, server.tsbuffer, server.localProtoInfo, options.remoteAddress);
        this.id = options.id;
        (this.logger as Logger) = options.logger;

        // To be override ...
        // Init connection (http req/res, ws conn, ...)
    }

    protected _disconnect(isManual: boolean, reason?: string, code?: number): void {
        super._disconnect(isManual, reason, code);
        this.server.connections.delete(this);
    }

}

export interface BaseServerConnectionOptions {
    dataType: BaseConnectionDataType,
    id: number,
    remoteAddress: string,
    logger: PrefixLogger
}
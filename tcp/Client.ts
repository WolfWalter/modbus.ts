/// <reference types="node" />
import { Socket, createConnection } from "net";
import * as debug from "debug";
import { Validate } from "container.ts/lib/validate";
import { Observable, Subject, BehaviorSubject, TimeoutError } from "./rx";
import { PduResponse, PduException, PduClient } from "../pdu";
import * as tcp from "./tcp";

/** Modbus TCP client response types. */
export type TcpClientResponse = tcp.TcpResponse | tcp.TcpException | null;

/**
 * Modbus TCP client options.
 */
export interface ITcpClientOptions {
  host: string;
  port?: number;
  unitId?: number;
}

/**
 * Modbus TCP client.
 */
export class TcpClient {

  /** Error codes. */
  public static ERROR = {
    CONNECTION: "TcpClientConnectionError",
    TIMEOUT: "TcpClientTimeoutError",
  };

  private _debug: any;

  private _host: string;
  private _port: number;
  private _unitId: number;
  private _transactionId = 0;
  private _protocolId = 0;

  private _socket: Socket | null;
  private _connected = new BehaviorSubject<boolean>(false);
  private _error = new BehaviorSubject<any>(null);

  private _buffer = Buffer.allocUnsafe(0);
  private _receive = new Subject<tcp.TcpResponse | tcp.TcpException>();
  private _transmit = new Subject<tcp.TcpRequest>();

  private _retries = 0;
  private _bytesReceived = 0;
  private _bytesTransmitted = 0;
  private _packetsReceived = 0;
  private _packetsTransmitted = 0;

  /** Host the client will connect to. */
  public get host(): string { return this._host; }

  /** Port the client will connect to. */
  public get port(): number { return this._port; }

  /** Host:port the client will connect to. */
  public get address(): string { return `${this.host}:${this.port}`; }

  /** Identifier of a remote slave. */
  public get unitId(): number { return this._unitId; }

  /** Socket connected state stream. */
  public get connected(): Observable<boolean> { return this._connected; }

  /** Returns true if client is connected. */
  public get isConnected(): boolean { return this._connected.value; }

  /** Socket errors stream. */
  public get error(): Observable<any> { return this._error; }

  /** Last error code returned by client socket. */
  public get errorCode(): string | null {
    if (this._error.value != null) {
      if (this._error.value.code != null) {
        return this._error.value.code;
      }
      return this._error.value;
    }
    return null;
  }

  /** Total number of retries performed by client. */
  public get retries(): number { return this._retries; }

  /** Number of bytes received by client. */
  public get bytesReceived(): number { return this._bytesReceived; }

  /** Number of bytes transmitted by client. */
  public get bytesTransmitted(): number { return this._bytesTransmitted; }

  /** Number of packets recevied by client. */
  public get packetsReceived(): number { return this._packetsReceived; }

  /** Number of packets transmitted by client. */
  public get packetsTransmitted(): number { return this._packetsTransmitted; }

  /** Client internal debugging interface. */
  protected get debug(): any { return ((this._debug != null) ? this._debug : () => { }); }

  /** Node socket connection options. */
  protected get connectionOptions() { return { host: this._host, port: this._port }; }

  /** Get next transaction identifier. */
  protected get nextTransactionId(): number {
    this._transactionId = (this._transactionId + 1) % 0xFFFF;
    return this._transactionId;
  }

  /**
   * Create TCP client instance.
   * @param options Client options.
   * @param namespace Optional debug namespace.
   */
  public constructor(options: ITcpClientOptions, namespace?: string) {
    this._host = Validate.isString(options.host);
    this._port = Validate.isPort(String(options.port || 502));
    this._unitId = Validate.isInteger(String(options.unitId || 1), { min: 0x1, max: 0xFF });
    if (namespace != null) {
      this._debug = debug(namespace);
    }
  }

  /**
   * Connect the client to configured host:port.
   * Observable will emit next after connected, throw an error if
   * connection fails and complete when 'disconnect' is called.
   * Completes if no data transmitted or received after timeout.
   * @param timeout Seconds of socket inactivty which causes timeout error.
   */
  public connect(timeout = 30): Observable<boolean> {
    // Validate timeout argument and ensure client disconnected.
    timeout = this.validTimeout(timeout);
    this.disconnect();

    this.debug(`connect: ${this.address}`);
    // (Re)create socket, reset receive buffer.
    // Error listener required to prevent process exit.
    this._socket = createConnection(this.connectionOptions);
    this._socket.on("error", (error) => { this._error.next(error); });
    this._buffer = Buffer.allocUnsafe(0);

    // Will emit next(false) and complete with call to 'disconnect' method.
    // Will emit next(false) and error if socket closes or times out due to inactivity.
    const disconnected = this.connected.skip(1).filter((b) => !b);

    // Race socket close/connect events to determine client state.
    // Connect event will emit next(true).
    // Close event will emit next(false) and throw an error.
    const socketClose = Observable.fromEvent(this._socket, "close")
      .takeUntil(disconnected)
      .mergeMap((hadError) => Observable.of({ name: "close", hadError }));

    const socketConnect = Observable.fromEvent(this._socket, "connect")
      .takeUntil(disconnected)
      .mergeMap(() => Observable.of({ name: "connect", hadError: false }));

    Observable.race(socketClose, socketConnect)
      .subscribe((value) => {
        if (value.name === "connect") {
          this.setSocketState(true);
        } else if (value.name === "close") {
          this.disconnect(TcpClient.ERROR.CONNECTION);
        }
      });

    // Socket data event receives data into internal buffer and processes responses.
    Observable.fromEvent(this._socket, "data")
      .takeUntil(disconnected)
      .subscribe((buffer: Buffer) => {
        this._buffer = this.receiveData(this._buffer, buffer);
      });

    // Requests transmitted via socket.
    this._transmit
      .takeUntil(disconnected)
      .subscribe((request) => this.writeSocket(request));

    // If no activity occurs on socket for timeout duration, client is disconnected.
    Observable.race(this._transmit, this._receive)
      .takeUntil(disconnected)
      .timeout(timeout)
      .subscribe({
        error: () => this.disconnect(TcpClient.ERROR.TIMEOUT),
      });

    // Emits next if socket connected, completes if 'disconnect' method called,
    // throws an error if socket closes.
    return this.connected.skip(1).filter((v) => v);
  }

  /**
   * Disconnect the client from the configured host:port, if connected.
   * Completes subscribers to 'connect' method or throws an error.
   */
  public disconnect(_error?: string): void {
    this.setSocketState(false, !_error, _error);
    this.destroySocket();
  }

  /**
   * This function code is used to read from 1 to 2000 contiguous status
   * of coils in a remote device.
   * @param startingAddress Starting address.
   * @param quantityOfCoils Quantity of coils.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public readCoils(
    startingAddress: number,
    quantityOfCoils: number,
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.readCoils(startingAddress, quantityOfCoils);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to read from 1 to 2000 contiguous status
   * of discrete inputs in a remote device.
   * @param startingAddress Starting address.
   * @param quantityOfInputs Quantity of inputs.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public readDiscreteInputs(
    startingAddress: number,
    quantityOfInputs: number,
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.readDiscreteInputs(startingAddress, quantityOfInputs);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to read  the contents of a contiguous block
   * of holding registers in a remote device.
   * @param startingAddress Starting address.
   * @param quantityOfRegisters Quantity of registers.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public readHoldingRegisters(
    startingAddress: number,
    quantityOfRegisters: number,
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.readHoldingRegisters(startingAddress, quantityOfRegisters);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to read from 1 to 125 contiguous input
   * registers in a remote device.
   * @param startingAddress Starting address.
   * @param quantityOfRegisters Quantity of registers.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public readInputRegisters(
    startingAddress: number,
    quantityOfRegisters: number,
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.readInputRegisters(startingAddress, quantityOfRegisters);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to write a single output to either ON
   * or OFF in a remote device.
   * @param outputAddress Output address.
   * @param outputValue  Output value.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public writeSingleCoil(
    outputAddress: number,
    outputValue: boolean,
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.writeSingleCoil(outputAddress, outputValue);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to write a single holding register
   * in a remote device.
   * @param registerAddress Register address.
   * @param registerValue Register value.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public writeSingleRegister(
    registerAddress: number,
    registerValue: number,
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.writeSingleRegister(registerAddress, registerValue);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to force each coil in a sequence of coils to
   * either ON or OFF in a remote device.
   * @param startingAddress Starting address.
   * @param outputValues Output values.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public writeMultipleCoils(
    startingAddress: number,
    outputValues: boolean[],
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.writeMultipleCoils(startingAddress, outputValues);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /**
   * This function code is used to write a block of contiguous registers
   * (1 to 123 registers) in a remote device.
   * @param startingAddress Starting address.
   * @param registerValues Register values.
   * @param timeout Number of seconds to wait for response (1 - 30).
   * @param retry Number of retries (0 - 5).
   */
  public writeMultipleRegisters(
    startingAddress: number,
    registerValues: number[],
    timeout = 5,
    retry = 0,
  ): Observable<tcp.TcpResponse> {
    const pduRequest = PduClient.writeMultipleRegisters(startingAddress, registerValues);
    const request = this.aduHeader(pduRequest.functionCode, pduRequest.buffer);
    return this.writeRequest(request, timeout, retry);
  }

  /** Validate and convert timeout in seconds to milliseconds. */
  protected validTimeout(value: number): number {
    return Validate.isInteger(String(value), { min: 1, max: 120 }) * 1000;
  }

  /** Validate number of retries. */
  protected validRetry(value: number): number {
    return Validate.isInteger(String(value), { min: 0, max: 10 });
  }

  /** Set client socket state. */
  protected setSocketState(connected: boolean, disconnect = false, error?: string): void {
    this._connected.next(connected);

    // Reset connected subject in case of disconnect.
    if (disconnect) {
      this._connected.complete();
    }
    if (error != null) {
      this._error.next(error);
      this._connected.error(error);
    }
    if (disconnect || (error != null)) {
      this._connected = new BehaviorSubject<boolean>(false);
    }
  }

  /** Destroy client socket. */
  protected destroySocket(): void {
    if (this._socket != null) {
      this.debug(`disconnect: ${this.address} (${this.errorCode})`);
      this._socket.end();
      this._socket.destroy();
      this._socket = null;
    }
  }

  /** Write request to client socket. */
  protected writeSocket(request: tcp.TcpRequest): Observable<void> {
    if (this._socket != null) {
      this.debug(`transmit: ${request}`);
      this._socket.write(request.buffer);
      this._bytesTransmitted += request.buffer.length;
      this._packetsTransmitted += 1;
    }
    return Observable.of(undefined);
  }

  /** Construct and prepend MBAP header to PDU request buffer. */
  protected aduHeader(functionCode: number, request: Buffer): tcp.TcpRequest {
    const buffer = Buffer.concat([Buffer.allocUnsafe(7), request]);
    const transactionId = this.nextTransactionId;

    buffer.writeUInt16BE(transactionId, 0);
    buffer.writeUInt16BE(this._protocolId, 2);
    buffer.writeUInt16BE((request.length + 1), 4);
    buffer.writeUInt8(this._unitId, 6);

    return new tcp.TcpRequest(transactionId, this._unitId, functionCode, buffer);
  }

  /** Write request to socket and wait for response, throw an error if exception returned. */
  protected writeRequest(request: tcp.TcpRequest, timeout = 5, retry = 0): Observable<tcp.TcpResponse> {
    timeout = this.validTimeout(timeout);
    retry = this.validRetry(retry);

    // Write to socket via transmit subject.
    this._transmit.next(request);

    // Wait for response with matching transaction/unit identifers to be received.
    return this._receive
      .filter((response) => {
        // Match transaction and unit identifiers of incoming responses.
        const transactionIdMatch = (response.transactionId === request.transactionId);
        const unitIdMatch = (response.unitId === request.unitId);
        return transactionIdMatch && unitIdMatch;
      })
      .take(1)
      .timeout(timeout)
      .retryWhen((errors) => {
        return errors
          .scan((errorCount, error) => {
            // If client is still connected and error is a timeout, retry up to limit.
            if (this.isConnected && (error instanceof TimeoutError)) {
              if (errorCount >= retry) {
                throw TcpClient.ERROR.TIMEOUT;
              }
              // Increment number of retries, retransmit request.
              this._retries += 1;
              this._transmit.next(request);
              return errorCount + 1;
            }
            // Throw now for unknown errors.
            throw error;
          }, 0);
      })
      .switchMap((response) => {
        if (response instanceof tcp.TcpResponse) {
          return Observable.of(response);
        } else {
          return Observable.throw(response);
        }
      });
  }

  /** Receive data into buffer, parse responses using response handler. */
  protected receiveData(buffer: Buffer, data: Buffer): Buffer {
    buffer = Buffer.concat([buffer, data]);
    this._bytesReceived += data.length;

    // Check if buffer may contain MBAP header.
    if (buffer.length >= 7) {
      const header = buffer.slice(0, 7);
      const headerLength = header.readUInt16BE(4);
      const responseLength = 6 + headerLength;

      // If buffer contains complete response, extract it now.
      if (buffer.length >= responseLength) {
        this._packetsReceived += 1;

        const aduBuffer = buffer.slice(0, responseLength);
        const transactionId = aduBuffer.readUInt16BE(0);
        const unitId = aduBuffer.readUInt8(6);
        const pduBuffer = aduBuffer.slice(7);

        // Parse buffer into response.
        const response = this.responseHandler(transactionId, unitId, pduBuffer, aduBuffer);
        if (response != null) {
          this.debug(`receive: ${response}`);
          this._receive.next(response);
        }

        // Return buffer with packet removed.
        return buffer.slice(responseLength);
      }
    }

    // Return concatenated buffers.
    return buffer;
  }

  /**
   * Parse buffer into response.
   * Inheritors may overwrite this function to implement their own response handler.
   */
  protected responseHandler(
    transactionId: number,
    unitId: number,
    pduBuffer: Buffer,
    aduBuffer: Buffer,
  ): TcpClientResponse {
    const pduResponse = PduClient.responseHandler(pduBuffer);
    let response: tcp.TcpResponse | tcp.TcpException | null = null;

    if (pduResponse instanceof PduResponse) {
      response = new tcp.TcpResponse(
        transactionId,
        unitId,
        pduResponse.functionCode,
        pduResponse.data,
        aduBuffer,
      );
    } else if (pduResponse instanceof PduException) {
      response = new tcp.TcpException(
        transactionId,
        unitId,
        pduResponse.functionCode,
        pduResponse.exceptionFunctionCode,
        pduResponse.exceptionCode,
        aduBuffer,
      );
    }

    return response;
  }

}
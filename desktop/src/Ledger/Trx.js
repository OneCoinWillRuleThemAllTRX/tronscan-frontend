/********************************************************************************
 *   Ledger Node JS API
 *   (c) 2016-2017 Ledger
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ********************************************************************************/

const { splitPath, foreach } = require("./utils");

const CLA = 0xE0;
const PATH_SIZE = 4;
const PATHS_LENGTH_SIZE = 1;
const CHUNK_SIZE = 150;

/**
 * Tron API
 *
 * @example
 * import Trx from "@ledgerhq/hw-app-trx";
 * const trx = new Trx(transport)
 */
export default class Trx {

  constructor(transport) {
    this.transport = transport;
    transport.decorateAppAPIMethods(
      this,
      [
        "getAddress",
        "signTransaction",
        "signPersonalMessage",
        "getAppConfiguration"
      ],
      "w0w"
    );
  }

  /**
   * Get TRX address for a given BIP 32 path.
   * cla: number, is 0xE0
   * ins: number, is the function 0x02 publickey 0x04 sign 0x06 configuration
   * p1: number, is used to get confirmation, set as 0 for now
   * p2: number,is used to chain, we dont have itm so 0 too
   * @param path a path in BIP 32 format
   * @option boolDisplay optionally enable or not the display
   * @option boolChaincode optionally enable or not the chaincode request
   * @return an object with a publicKey, address and (optionally) chainCode
   * @example
   * eth.getAddress("44'/60'/0'/0'/0").then(o => o.address)
   */
  getAddress(
    path,
    boolDisplay,
    boolChaincode
  ) {
    let paths = splitPath(path);
    let buffer = new Buffer(1 + paths.length * 4);
    buffer[0] = paths.length;
    paths.forEach((element, index) => {
      buffer.writeUInt32BE(element, 1 + 4 * index);
    });

    return this.transport
      .send(
        CLA,
        0x02,
        boolDisplay ? 0x01 : 0x00,
        boolChaincode ? 0x01 : 0x00,
        buffer
      )
      .then(response => {

        let result = {};

        result.privateKey = response.slice(0, 65);
        result.address = response.slice(67, 101).toString();
        return result;
      });
  }

  /**
   * You can sign a transaction and retrieve v, r, s given the raw transaction and the BIP 32 path of the account to sign
   * @example
   eth.signTransaction("44'/60'/0'/0'/0", "e8018504e3b292008252089428ee52a8f3d6e5d15f8b131996950d7f296c7952872bd72a2487400080").then(result => ...)
   */
  async signTransaction(
    path,
    rawTxHex
  ) {

    let paths = splitPath(path);
    let rawTx = new Buffer(rawTxHex, "hex");

    let buffers = [];
    let offset = 0;

    console.log("GOT SIGN REQUEST");

    while (offset !== rawTx.length) {
      let maxChunkSize = offset === 0 ?
        CHUNK_SIZE - PATHS_LENGTH_SIZE - (paths.length * PATH_SIZE)
        : CHUNK_SIZE;

      let chunkSize = offset + maxChunkSize > rawTx.length
          ? rawTx.length - offset
          : maxChunkSize;

      let buffer = new Buffer(
        offset === 0 ? 1 + paths.length * PATH_SIZE + chunkSize : chunkSize
      );

      if (offset === 0) {
        buffer[0] = paths.length;
        paths.forEach((element, index) => {
          buffer.writeUInt32BE(element, 1 + 4 * index);
        });
        rawTx.copy(buffer, PATHS_LENGTH_SIZE + PATH_SIZE * paths.length, offset, offset + chunkSize);
      } else {
        rawTx.copy(buffer, 0, offset, offset + chunkSize);
      }

      buffers.push(buffer);
      offset += chunkSize;
    }

    if (buffers.length === 1) {
      buffers = [
        [0x10, buffers[0]]
      ];
    } else if (buffers.length > 1) {
      buffers = buffers.map((p, i) => {
        let startByte;
        if (i === 0) {
          startByte = 0x00;
        } else if (buffers.length > 1 && i === buffers.length - 1) {
          startByte = 0x90;
        } else {
          startByte = 0x80;
        }

        return [startByte, p];
      });
    }

    console.log("CHUNKS", buffers.length);

    let response;
    return foreach(buffers, ([startByte, data]) => {
      console.log("SENDING", startByte, data.length, data.toString("hex"));
      return this.transport
        .send(CLA, 0x04, startByte, 0x00, data)
        .then(apduResponse => {
          response = apduResponse;
        });
    }).then(() => response);
  }

  /**
   */
  getAppConfiguration() {
    return this.transport.send(0xe0, 0x06, 0x00, 0x00).then(response => {
      let result = {};
      result.arbitraryDataEnabled = response[0] & 0x01;
      result.version = "" + response[1] + "." + response[2] + "." + response[3];
      return result;
    });
  }

  /**
  * You can sign a message according to eth_sign RPC call and retrieve v, r, s given the message and the BIP 32 path of the account to sign.
  * @example
eth.signPersonalMessage("44'/60'/0'/0'/0", Buffer.from("test").toString("hex")).then(result => {
  var v = result['v'] - 27;
  v = v.toString(16);
  if (v.length < 2) {
    v = "0" + v;
  }
  console.log("Signature 0x" + result['r'] + result['s'] + v);
})
   */
  signPersonalMessage(
    path,
    messageHex
  ) {
    let paths = splitPath(path);
    let offset = 0;
    let message = new Buffer(messageHex, "hex");
    let toSend = [];
    let response;
    while (offset !== message.length) {
      let maxChunkSize = offset === 0 ? 150 - 1 - paths.length * 4 - 4 : 150;
      let chunkSize = offset + maxChunkSize > message.length
          ? message.length - offset
          : maxChunkSize;
      let buffer = new Buffer(
        offset === 0 ? 1 + paths.length * 4 + 4 + chunkSize : chunkSize
      );
      if (offset === 0) {
        buffer[0] = paths.length;
        paths.forEach((element, index) => {
          buffer.writeUInt32BE(element, 1 + 4 * index);
        });
        buffer.writeUInt32BE(message.length, 1 + 4 * paths.length);
        message.copy(
          buffer,
          1 + 4 * paths.length + 4,
          offset,
          offset + chunkSize
        );
      } else {
        message.copy(buffer, 0, offset, offset + chunkSize);
      }
      toSend.push(buffer);
      offset += chunkSize;
    }
    return foreach(toSend, (data, i) =>
      this.transport
        .send(0xe0, 0x08, i === 0 ? 0x00 : 0x80, 0x00, data)
        .then(apduResponse => {
          response = apduResponse;
        })
    ).then(() => {
      const v = response[0];
      const r = response.slice(1, 1 + 32).toString("hex");
      const s = response.slice(1 + 32, 1 + 32 + 32).toString("hex");
      return { v, r, s };
    });
  }
}
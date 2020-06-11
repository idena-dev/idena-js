import Provider from './Provider'
import Transaction from '../models/Transaction'
import Identity from '../models/Identity'
// @ts-ignore
import { ledgerUSBVendorId } from '@ledgerhq/devices'
// @ts-ignore
import { listen } from '@ledgerhq/logs'
// @ts-ignore
import TransportWebHID from '@ledgerhq/hw-transport-webhid'
import { decode } from '@stablelib/utf8'
import { Rpc } from '../services/Rpc'
const struct = require('python-struct')

export = class ProviderLedger implements Provider {
  // @ts-ignore
  private transport: any
  private address: string
  private addressIndex: number
  private rpc: Rpc

  constructor (uri: string = 'https://rpc.idena.dev') {
    this.rpc = new Rpc(uri)
  }

  getHID () {
    const { hid } = navigator as any
    if (!hid) throw new Error('navigator.hid is not supported')

    return hid
  }

  async requestLedgerDevice () {
    const device = await this.getHID().requestDevice({
      filters: [{ vendorId: ledgerUSBVendorId }]
    })

    if (device.length === 0) throw new Error('no device selected')

    return device
  }

  async supportedTransports () {
    const support = await Promise.all([
      TransportWebHID.isSupported().then((supported: boolean) =>
        supported ? 'hid' : null
      )
    ])

    return support.filter(t => t)
  }

  async connect () {
    if (this.transport) return
    listen((log: any) => console.debug(log))

    const transports = await this.supportedTransports()

    if (transports.indexOf('hid') !== -1) {
      const approved = await TransportWebHID.list()

      if (!Array.isArray(approved) || approved.length === 0)
        await this.requestLedgerDevice()

      this.transport = await TransportWebHID.openConnected()
    } else throw new Error('no supported transports')

    this.transport.setScrambleKey('')

    if (!this.address || !this.addressIndex) await this.getAddress()
  }

  private async exchange (cmd: Buffer): Promise<Uint8Array> {
    if (!this.transport) await this.connect()
    const resp = await this.transport.exchange(cmd)
    return Uint8Array.from(resp.slice(0, resp.length - 2))
  }

  private parseBip32Path (path: string) {
    if (path.length === 0) return new Uint8Array()
    let result: Buffer[] = []
    let elements = path.split('/')
    elements.forEach(pathElement => {
      const element = pathElement.split("'")
      if (element.length === 1)
        result = result.concat(struct.pack('>I', parseInt(element[0])))
      else
        result = result.concat(
          struct.pack('>I', ~0x80000000 + 1 + parseInt(element[0]))
        )
    })
    return Buffer.concat(result)
  }

  async sign (message: Buffer): Promise<Buffer> {
    if (!this.transport || !this.address || !this.addressIndex)
      await this.connect()
    const donglePath = this.parseBip32Path(`44'/515'/0'/0/${this.addressIndex}`)
    const cmd = Buffer.concat([
      Buffer.from('e0040000', 'hex'),
      Buffer.from(String.fromCharCode(donglePath.length + 1 + message.length)),
      Buffer.from(String.fromCharCode(Math.floor(donglePath.length / 4))),
      donglePath,
      message
    ])
    const signedMessage = await this.exchange(cmd)
    if (signedMessage.length === 0) throw Error('Open idena-ledger app')
    return Buffer.from(signedMessage)
  }

  inject (signedMessage: Buffer): Promise<string> {
    const hexSignedMessage = '0x' + signedMessage.toString('hex')
    return this.rpc.inject(hexSignedMessage)
  }

  async getAddress (index?: number): Promise<string> {
    if (!this.transport) await this.connect()
    if (this.address) return this.address
    const donglePath = this.parseBip32Path(`44'/515'/0'/0/${index || 0}`)

    const cmd = Buffer.concat([
      Buffer.from('e0020100', 'hex'),
      Buffer.from(String.fromCharCode(donglePath.length + 1)),
      Buffer.from(String.fromCharCode(Math.floor(donglePath.length / 4))),
      donglePath
    ])

    const resp = await this.exchange(cmd)
    if (resp.length === 0) throw Error('Open idena-ledger app')
    const offset = 1 + resp[0]
    const address =
      '0x' + decode(resp.slice(offset + 1, offset + 1 + resp[offset]))
    this.address = address
    this.addressIndex = index || 0
    return address
  }

  async getNonceByAddress (address: string): Promise<number> {
    return this.rpc.getNonceByAddress(address)
  }

  async getBalanceByAddress (
    address: string
  ): Promise<{ balance: number; stake: number }> {
    return this.rpc.getBalanceByAddress(address)
  }

  async getTransactionByHash (hash: string): Promise<Transaction> {
    const result = await this.rpc.getTransactionByHash(hash)
    return Transaction.deserialize(this, {
      hash: result.hash,
      nonce: result.nonce,
      type: result.type === 'send' ? 0 : -1,
      to: result.to,
      from: result.from,
      amount: result.amount,
      epoch: result.epoch,
      payload: result.payload,
      blockHash: result.blockHash,
      usedFee: result.usedFee,
      timestamp: new Date(result.timestamp * 1000)
    })
  }

  async getIdentityByAddress (address: string): Promise<Identity> {
    return this.rpc.getIdentityByAddress(address)
  }

  async getEpoch (): Promise<number> {
    return this.rpc.getEpoch()
  }

  getMaxFeePerByte (): Promise<number> {
    return this.rpc.getMaxFeePerByte()
  }

  close (): Promise<void> {
    return this.transport.close()
  }
}

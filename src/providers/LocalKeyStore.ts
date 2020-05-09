import Provider from "./Provider";
import request from "request-promise";
import Transaction from "../models/Transaction";
import Identity from "../models/Identity";
import * as secp256k1 from "noble-secp256k1";
import { keccak256 } from "@ethersproject/keccak256";

export = class LocalKeyStore implements Provider {

    private readonly privateKey: string;
    private rpc: string;

    constructor(privateKey?: string, rpc: string = "https://rpc.idena.dev") {
        if (privateKey === undefined)
            this.privateKey = secp256k1.utils.randomPrivateKey().toString();
        this.privateKey = privateKey;
        this.rpc = rpc;
    }

    async sign(message: Buffer): Promise<Buffer> {
        const digest = keccak256(message);
        let [ sig ] = await secp256k1.sign(digest, this.privateKey, { recovered: true });
        const r = sig.slice(0, 32);
        const s = sig.slice(32, 64);
        let v = parseInt(sig[64]);
        if (v !== 27 && v !== 28) {
            v = 27 + (v % 2);
        }
        const recoveryParam = (v - 27);
        return Buffer.concat([
            Buffer.from(r, "hex"),
            Buffer.from(s, "hex"),
            Buffer.from([recoveryParam]),
        ]);
    }

    inject(signedMessage: Buffer): Promise<string> {
        const hexSignedMessage = "0x"+signedMessage.toString("hex");
        return this.request("bcn_sendRawTx", [hexSignedMessage]);
    }

    getAddress(): Promise<string> {
        const publicKey = secp256k1.getPublicKey(this.privateKey);
        const address = keccak256(Buffer.from(publicKey));
        console.log(address);
        return Promise.resolve(address);
    }

    async getEpoch(): Promise<number> {
        const result = await this.request("dna_epoch");
        return result.epoch;
    }

    async getNonceByAddress(address: string): Promise<number> {
        const { nonce } = await this.request("dna_getBalance", [address]);
        return nonce;
    }

    async getBalanceByAddress(address: string): Promise<{ balance: number, stake: number }> {
        const { balance, stake } = await this.request("dna_getBalance", [address]);
        return { balance, stake };
    }

    async getTransactionByHash(hash: string): Promise<Transaction> {
        let result = await this.request("bcn_transaction", [hash]);
        return Transaction.deserialize(this, {
            hash: result.hash,
            nonce: result.nonce,
            type: result.type === "send" ? 0 : -1,
            to: result.to,
            from: result.from,
            amount: result.amount,
            epoch: result.epoch,
            payload: result.payload,
            blockHash: result.blockHash,
            usedFee: result.usedFee,
            timestamp: new Date(result.timestamp*1000),            
        });
    }

    async getIdentityByAddress(address: string): Promise<Identity> {
        let identity: any = this.request("dna_identity", [address]);
        identity.penalty = parseFloat(identity.penalty);
        return identity;
    }

    private request(method: string, params: any[] = []) {
        return request({
            url: this.rpc,
            json: {
                id: 1,
                method,
                params
            },
            method: "POST",
            headers: {
                "content-type": "application/json",
            }
        }).then(r => {
            if (!r) {
                throw Error(`${method} could be blacklisted`)
            }
            if (r && r.error && r.error.message)
                throw Error(r.error.message);
            if (!r.result)
                throw Error("unknown error");
            return r.result;
        });
    }

}

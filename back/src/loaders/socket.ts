import wsModule from 'ws';
import { Application } from 'express';
import Emitter from '@helper/eventEmitter';
import { binArrayToJson, JsonToBinArray } from '@helper/tools';
import { StockError, StockErrorMessage } from '@errors/index';
import Logger from './logger';
import { ISocketRequest } from '../interfaces/socketRequest';
import StockService from '../services/StockService';

const loginUserMap = new Map();
const socketClientMap = new Map();
const socketAlarmMap = new Map();
const translateRequestFormat = (data) => binArrayToJson(data);
const translateResponseFormat = (type, data) => JsonToBinArray({ type, data });
const getNemClientForm = () => {
	return { target: '', alarmToken: '' };
};

const sendAlarmMessage = (userId, msg) => {
	const client = socketAlarmMap.get(userId);
	client?.send(translateResponseFormat('notice', msg));
};

const connectNewUser = async (client) => {
	try {
		const stockService = new StockService();
		const stockList = await stockService.getStocksCurrent();

		client.send(translateResponseFormat('stocksInfo', stockList));
		socketClientMap.set(client, getNemClientForm());
	} catch (error) {
		throw new StockError(StockErrorMessage.CANNOT_READ_STOCK_LIST);
	}
};
const disconnectUser = (client) => {
	const { alarmToken } = socketClientMap.get(client);
	const userId = loginUserMap.get(alarmToken);
	socketAlarmMap.delete(userId);
	socketClientMap.delete(client);
};

export default async (app: Application): Promise<void> => {
	const HTTPServer = app.listen(process.env.SOCKET_PORT || 3333, () => {
		Logger.info(`✌️ Socket loaded at port:${process.env.SOCKET_PORT || 3333}`);
	});
	const webSocketServer = new wsModule.Server({ server: HTTPServer });
	webSocketServer.binaryType = 'arraybuffer';

	const broadcast = ({ stockCode, msg }) => {
		socketClientMap.forEach(({ target: targetStockCode }, client) => {
			if (targetStockCode === stockCode) {
				// 모든 데이터 전송, 현재가, 호가, 차트 등...
				client.send(translateResponseFormat('updateTarget', msg));
			} else {
				// msg 오브젝트의 데이터에서 aside 바에 필요한 데이터만 골라서 전송
				client.send(translateResponseFormat('updateStock', msg.match));
			}
		});
	};
	const loginUser = (userId, alarmToken) => {
		loginUserMap.set(alarmToken, userId);
	};
	const registerAlarmToken = (ws, alarmToken) => {
		socketClientMap.set(ws, { ...socketClientMap.get(ws), alarmToken });
		const userId = loginUserMap.get(alarmToken);
		if (userId) socketAlarmMap.set(userId, ws);
	};

	Emitter.on('broadcast', broadcast);
	Emitter.on('loginUser', loginUser);
	Emitter.on('order accepted', broadcast);
	Emitter.on('notice', sendAlarmMessage);

	webSocketServer.on('connection', async (ws, req) => {
		await connectNewUser(ws);

		ws.on('message', async (message: string) => {
			const requestData: ISocketRequest = translateRequestFormat(message);

			switch (requestData.type) {
				case 'open': {
					if (!socketClientMap.has(ws)) return;
					const stockService = new StockService();
					const stockCode = requestData.stockCode ?? '';
					const conclusions = await stockService.getConclusionByCode(stockCode);

					ws.send(translateResponseFormat('baseStock', { conclusions, charts: [] }));
					socketClientMap.set(ws, { ...socketClientMap.get(ws), target: stockCode });
					break;
				}
				case 'alarm': {
					const { alarmToken } = requestData;
					registerAlarmToken(ws, alarmToken);
					break;
				}
				default:
					ws.send(translateResponseFormat('error', '알 수 없는 오류가 발생했습니다.'));
			}
		});

		ws.on('close', () => {
			disconnectUser(ws);
		});
	});
};

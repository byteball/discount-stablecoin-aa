const path = require('path')
// eslint-disable-next-line no-unused-vars
const { Testkit, Utils } = require('aa-testkit')
const { Network } = Testkit({
	TESTDATA_DIR: path.join(__dirname, '../testdata'),
})

describe('Afterlife', function () {
	this.timeout(120 * 1000)

	before(async () => {
		this.network = await Network.create()
	//	this.explorer = await this.network.newObyteExplorer().ready()
		this.genesis = await this.network.getGenesisNode().ready();

		[
			this.deployer,
			this.alice,
		] = await Utils.asyncStartHeadlessWallets(this.network, 3)

		this.oracle = this.deployer
		this.oracleAddress = await this.oracle.getAddress()

		const { unit, error } = await this.genesis.sendBytes({
			toAddress: await this.deployer.getAddress(),
			amount: 1e9,
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		console.error('----- genesis', unit);

		await this.network.witnessUntilStable(unit)

		const balance = await this.deployer.getBalance()
		expect(balance.base.stable).to.be.equal(1e9)
	})

	it('Send bytes to Alice', async () => {
		this.aliceAddress = await this.alice.getAddress()
		const { unit, error } = await this.genesis.sendBytes({
			toAddress: this.aliceAddress,
			amount: 100e9,
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		console.error('---- to Alice', unit);

		await this.network.witnessUntilStable(unit)
		console.error('----- to Alice witnessed');
		const balance = await this.alice.getBalance()
		expect(balance.base.stable).to.be.equal(100e9)
	})

	it('Deploy template AA', async () => {
		const { address, unit, error } = await this.deployer.deployAgent(path.join(__dirname, '../stablecoin.oscript'))

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		expect(address).to.be.validAddress

		this.baseAAAddress = address

		await this.network.witnessUntilStable(unit)
	})

	it('Deploy AA', async () => {
		const { address, unit, error } = await this.deployer.deployAgent({
			base_aa: this.baseAAAddress,
			params: {
				oracle: this.oracleAddress,
				overcollateralization_ratio: 1.5,
				max_loan_value_in_underlying: 10000000, 
				decimals: 2, 
				auction_period: 3600, 
				liquidation_ratio: 1.3, 
				feed_name: 'GBYTE_USD',
				ma_feed_name: 'GBYTE_USD_MA',
				expiry_date: new Date(Date.now() + 7*24*3600*1000).toISOString().substr(0, 10)
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		expect(address).to.be.validAddress

		this.aaAddress = address

		await this.network.witnessUntilStable(unit)
	})

	it('Define stablecoin asset', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.aaAddress,
			amount: 1e4,
			data: {
				define: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		this.asset = response.response_unit
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		expect(response.response.responseVars.asset).to.be.equal(this.asset)

		const { vars } = await this.alice.readAAStateVars(this.aaAddress)
		expect(vars['asset']).to.be.equal(this.asset)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		const assetMessage = unitObj.messages.find(m => m.app === 'asset')
		expect(assetMessage.payload.is_transferrable).to.be.equal(true)
	})

	it('Post data feed', async () => {
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: 20,
					GBYTE_USD_MA: 25,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(20)
		await this.network.witnessUntilStable(unit)
	})

	it('Alice issues (borrows) stablecoins', async () => {
		const amount = 1e9 * 1.5
		const expectedLoanAmount = 2000

		const { unit, error } = await this.alice.sendBytes({
			toAddress: this.aaAddress,
			amount: amount,
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit)
		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		this.loanId = response.response_unit

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		expect(response.response.responseVars.amount).to.be.equal(expectedLoanAmount)
		expect(response.response.responseVars.id).to.be.equal(response.response_unit)

		this.loanAmount = expectedLoanAmount
		this.collateralAmount = amount

		const { vars } = await this.alice.readAAStateVars(this.aaAddress)
		expect(vars['circulating_supply']).to.be.equal(expectedLoanAmount+'')
		expect(vars[this.loanId + '_owner']).to.be.equal(this.aliceAddress)
		expect(vars[this.loanId + '_collateral']).to.be.equal(amount+'')
		expect(vars[this.loanId + '_amount']).to.be.equal(expectedLoanAmount+'')

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		const paymentMessage = unitObj.messages.find(m => m.app === 'payment' && m.payload.asset === this.asset)
		expect(paymentMessage.payload.asset).to.be.equal(this.asset)
		const aliceOutput = paymentMessage.payload.outputs.find(o => o.address === this.aliceAddress)
		expect(aliceOutput.amount).to.be.equal(expectedLoanAmount)

		await this.network.witnessUntilStable(response.response_unit)

	})

	it('Record the exchange rate too early - should fail', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.aaAddress,
			amount: 1e4,
			data: {
				expire: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("neither case is true in messages")
		expect(response.bounced).to.be.true
	})

	it('Fast forward to expiry and post a new data feed', async () => {
		const { time_error } = await this.network.timetravel({shift: '7d'})
		expect(time_error).to.be.undefined

		this.finalExchangeRate = 30
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: this.finalExchangeRate,
					GBYTE_USD_MA: '29',
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(this.finalExchangeRate)
		await this.network.witnessUntilStable(unit)
	})

	it('Record the exchange rate', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.aaAddress,
			amount: 1e4,
			data: {
				expire: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		expect(response.response.responseVars.expiry_exchange_rate).to.be.equal(this.finalExchangeRate)

		const { vars } = await this.alice.readAAStateVars(this.aaAddress)
		expect(vars['expiry_exchange_rate']).to.be.equal(this.finalExchangeRate+'')
	})

	it('Record the exchange rate again - should fail', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.aaAddress,
			amount: 1e4,
			data: {
				expire: 1,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("neither case is true in messages")
		expect(response.bounced).to.be.true
	})

	it('Alice exchanges USD to GBYTE', async () => {
		const amount = 500
		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset,
			base_outputs: [{ address: this.aaAddress, amount: 1e4 }],
			asset_outputs: [{ address: this.aaAddress, amount: amount }],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

	//	await this.network.witnessUntilStable(response.response_unit)
		
		this.circulatingSupply = this.loanAmount - amount

		const { vars } = await this.alice.readAAStateVars(this.aaAddress)
		expect(vars['circulating_supply']).to.be.equal(this.circulatingSupply.toString())

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		const paymentMessage = unitObj.messages.find(m => m.app === 'payment')
		const payout = paymentMessage.payload.outputs.find(out => out.address === this.aliceAddress)
		expect(payout.amount).to.be.equal(Math.floor(amount/100 / this.finalExchangeRate * 1e9))
		expect(paymentMessage.payload.asset).to.be.undefined

	})

	it('Alice exchanges GBYTE to USD', async () => {
		const amount = 10e9
		const { unit, error } = await this.alice.sendBytes({
			toAddress: this.aaAddress,
			amount: amount,
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

	//	await this.network.witnessUntilStable(response.response_unit)
		
		const outAmount = Math.floor((amount-1000) / 1e9 * this.finalExchangeRate * 100)
		this.circulatingSupply += outAmount

		const { vars } = await this.alice.readAAStateVars(this.aaAddress)
		expect(vars['circulating_supply']).to.be.equal(this.circulatingSupply.toString())

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		const paymentMessage = unitObj.messages.find(m => m.app === 'payment' && m.payload.asset === this.asset)
		const payout = paymentMessage.payload.outputs.find(out => out.address === this.aliceAddress)
		expect(payout.amount).to.be.equal(outAmount)

		await this.network.witnessUntilStable(response.response_unit) // must be stable for the next payment
	})

	it('Alice repays the loan', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset,
			base_outputs: [{ address: this.aaAddress, amount: 1e4 }],
			asset_outputs: [{ address: this.aaAddress, amount: this.loanAmount }],
			messages: [{
				app: 'data',
				payload: {
					repay: 1,
					id: this.loanId,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		
	//	await this.network.witnessUntilStable(response.response_unit)

		this.circulatingSupply -= this.loanAmount

		const { vars } = await this.alice.readAAStateVars(this.aaAddress)
		expect(vars['circulating_supply']).to.be.equal(this.circulatingSupply.toString())
		expect(vars[this.loanId + '_repaid']).to.be.equal('1')

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		const paymentMessage = unitObj.messages.find(m => m.app === 'payment')
		const payout = paymentMessage.payload.outputs.find(out => out.address === this.aliceAddress)
		expect(payout.amount).to.be.equal(this.collateralAmount)
		expect(paymentMessage.payload.asset).to.be.undefined

	})

	it('Alice tries to repay the loan again - should fail', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset,
			base_outputs: [{ address: this.aaAddress, amount: 1e4 }],
			asset_outputs: [{ address: this.aaAddress, amount: this.loanAmount }],
			messages: [{
				app: 'data',
				payload: {
					repay: 1,
					id: this.loanId,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.equal("already repaid")
		expect(response.bounced).to.be.true
	//	await this.network.witnessUntilStable(response.response_unit)
	})

	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
		// await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})

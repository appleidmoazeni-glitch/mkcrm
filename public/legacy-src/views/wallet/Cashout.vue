<template>
  <main class="main-content">
    <div class="row justify-content-md-center">
      <div class="col-lg-7">
        <div class="card">
          <div :class="['card-header d-flex justify-content-between', (step=='receipt'?'bg-success':'')]">
            <h5>انتقال وجه</h5>
            <h5 v-if="step!='receipt'">{{ time }}</h5>
          </div>
          <div :class="['card-body', (step=='receipt'||step=='final-check'?'p-0':'')]">
            <template v-if="step=='check'">
              <div class="form-group m-0">
                <label class="col-form-label">شماره شبا مقصد:</label>
                <div class="input-group">
                  <input id="iban" type="tel" maxlength="24" data-input-mask="iban" class="form-control form-control-lg">
                  <div class="input-group-prepend">
                    <span class="input-group-text">IR</span>
                  </div>
                </div>
              </div>
              <div class="form-group m-0">
                <label class="col-form-label">مبلغ: (ریال)</label>
                <input id="amount" type="tel" data-input-mask="money" maxlength="24" class="form-control form-control-lg">
              </div>
              <div class="form-group">
                <label class="col-form-label">توضیحات/بابت:</label>
                <input id="description" type="text" maxlength="24" class="form-control form-control-lg">
              </div>
            </template>

            <div v-else-if="step=='final-check'" class="receipt table-responsive">
              <b-overlay :show="erLoading" opacity="0.6" rounded="lg" class="modal-content">
                <table class="table table-hover">
                  <thead>
                  <tr>
                    <th class="text-center" colspan="2"><h5>اطلاعات حساب</h5></th>
                  </tr>
                  </thead>
                  <tbody>
                  <tr>
                    <th width="200">شماره حساب</th>
                    <td>
                      <span style="font-family: Arial" v-if="loadedIbanInfo">{{cashout.deposit}}</span>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  <tr>
                    <th>شماره شبا</th>
                    <td>
                      <span style="font-family: Arial" v-if="loadedIbanInfo">IR{{cashout.iban}}</span>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  <tr>
                    <th>نام بانک</th>
                    <td>
                      <template v-if="loadedIbanInfo">{{cashout.bank.title}}</template>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  <tr>
                    <th>نام مشتری</th>
                    <td>
                      <template v-if="loadedIbanInfo">{{cashout.fullname}}</template>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  <tr>
                    <th>وضعیت حساب</th>
                    <td>
                      <template v-if="loadedIbanInfo">{{cashout.status.title}}</template>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  </tbody>
                </table>

                <table class="table table-hover">
                  <thead>
                  <tr>
                    <th class="text-center" colspan="2"><h5>اطلاعات واریز</h5></th>
                  </tr>
                  </thead>
                  <tbody>
                  <tr>
                    <th width="200">مبلغ</th>
                    <td>
                      <template v-if="loadedIbanInfo">{{number_format(cashout.amount)}} ریال</template>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  <tr>
                    <th>توضیحات</th>
                    <td>
                      <template v-if="loadedIbanInfo">{{cashout.description}}</template>
                      <b-skeleton v-else animation="wave"></b-skeleton>
                    </td>
                  </tr>
                  </tbody>
                </table>
              </b-overlay>
            </div>

            <div v-else-if="step=='receipt'" class="receipt table-responsive">
              <table class="table">
                <thead>
                <tr>
                  <th class="text-center" colspan="2"><h5>رسید انتقال وجه</h5></th>
                </tr>
                </thead>
                <tbody>
                <tr>
                  <th width="200">مبلغ:</th>
                  <td>{{ number_format(cashout.amount) }} ریال</td>
                </tr>
                <tr>
                  <th>به شماره حساب</th>
                  <td>IR{{cashout.iban}}</td>
                </tr>
                <tr>
                  <th>متعلق به:</th>
                  <td>{{ cashout.fullname }}</td>
                </tr>
                <tr>
                  <th>با کد رهگیری:</th>
                  <td>{{ cashout.track_id }}</td>
                </tr>
                <tr>
                  <th>توضیحات/بابت:</th>
                  <td>{{ cashout.description }}</td>
                </tr>
                <tr>
                  <td class="text-center" colspan="2">در تاریخ: {{ new Date(cashout.accept.created_at).echoFa("Y/m/d") }}، ساعت:
                    {{ new Date(cashout.accept.created_at).echoFa("H:i:s") }} با موفقیت انتقال یافت</td>
                </tr>
                </tbody>
              </table>
            </div>

          </div>
          <div class="card-footer text-muted">
            <button v-if="step=='check'" @click="ibanInfo" class="btn btn-primary">استعلام اطلاعات</button>
            <template v-else-if="step=='final-check'">
              <template v-if="!erLoading">
                <button class="btn btn-warning ml-2" @click="backToCheck">اصلاح</button>
                <button class="btn btn-primary" @click="finalCheckOut">تایید و انتقال وجه</button>
              </template>
            </template>
            <template v-else-if="step=='receipt'">
              <button class="btn btn-warning ml-2" @click="backToCheck">بازگشت</button>
              <button class="btn btn-primary">چاپ</button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import util from '../../assets/pureFunctions'
import axios from "axios";
export default {
  data(){
    return {
      time: "00:00",
      step: "check",
      loadedIbanInfo: false,
      erLoading: false,
      cashout: {
        iban: "",
        deposit: "",
        amount: "",
        description: "",
        fullname: "",
        bank: {
          id: "",
          title: ""
        },
        status: {
          id: "",
          title: ""
        },
        accept: {
          is_accept: false,
          description: "",
          created_at: ""
        },
        track_id: ""
      },
      number_format: util.number_format
    }
  },
  methods:{
    ibanInfo(){
      let iban = document.getElementById("iban").value.replace(/ /g, "");
      let amount = parseInt(document.getElementById("amount").value.replace(/,/g, ""));
      let description = document.getElementById("description").value.trim();

      if( iban ){
        if( amount >= 10000 ){
          if( description ){
            this.step = 'final-check';
            this.cashout.iban = iban;
            this.cashout.amount = amount;
            this.cashout.description = description;
            this.cashout.fullname = "";
            axios.post('/admin/wallet/cashOut/ibanInfo', {iban: this.cashout.iban}).then(({data}) => {
              this.loadedIbanInfo = true;
              if( data && data.ok ){
                let fullnames = [];
                for(let fn of data.data.owners){
                  fullnames.push(fn.first_name + ' ' + fn.last_name);
                }
                this.cashout.deposit = data.data.deposit;
                this.cashout.fullname = fullnames.join("، ");
                this.cashout.status = data.data.status;
                this.cashout.bank = data.data.bank;
                util.setAuthenticateTime(data.expireTime)
              }else{
                toastr['error'](data.error);
              }
            });
          }else{
            toastr['error']("وارد کردن توضیحات تراکنش الزامی است.")
          }
        }else{
          toastr['error']("مبلغ وارد شده باید بالاتر از ۱۰ هزار تومان باشد.")
        }
      }else{
        toastr['error']("وارد کردن شماره شبا الزامی است.");
      }
    },
    backToCheck(){
      this.step = 'check';
      this.loadedIbanInfo = false;

      // $(document).find('[data-input-mask="money"]').mask('000,000,000,000,000', {reverse: true});
      // $(document).find('[data-input-mask="iban"]').mask('00 0000 0000 0000 0000 0000 00', {reverse: true});
    },
    finalCheckOut(){
      this.erLoading = true;
      if( this.cashout.iban ){
        if( this.cashout.amount >= 10000 ){
          axios.post('/admin/wallet/cashOut', {iban: this.cashout.iban, amount: this.cashout.amount, description: this.cashout.description}).then(({data}) => {
            this.erLoading = false;
            if( data && data.ok ){
              this.step = 'receipt';
              this.cashout.status = data.data.status;
              this.cashout.accept = data.data.accept;
              this.cashout.track_id = data.data.track_id;
              util.setAuthenticateTime(data.expireTime)
            }else{
              toastr['error'](data.error);
            }
          });
        }else{
          this.erLoading = false;
          toastr['error']("مبلغ تراکنش باید بیشتر از ۱۰ هزار ریال باشد.")
        }
      }else{
        this.erLoading = false;
        toastr['error']('شماره شبا یافت نشد.');
      }
    }
  },
  mounted() {
    if(!util.getAuthenticateTime()){
      this.$router.push('/wallet/authenticate');
    }
    let timer = setInterval(()=>{
      let tm = util.getAuthenticateTime();
      this.time = util.toTimeFormat(tm);
      if( tm < 1 ){
        clearInterval(timer);
        this.$router.push('/wallet/authenticate');
      }
    }, 1000);
    $(function(){
      $('[data-input-mask="money"]').mask('000,000,000,000,000', {reverse: true});
      $('[data-input-mask="iban"]').mask('00 0000 0000 0000 0000 0000 00', {reverse: true});
    });
  }
}
</script>

<style scoped>
#iban{
  font-family: "Arial";
  font-weight: 900;
  direction: ltr;
  text-align: center;
  letter-spacing: 4px;
}
#iban+div>span{
  font-family: "Arial";
  font-weight: 900;
  border-radius: 6px 0 0 6px;
  padding: 0 18px;
}
#amount{
  font-family: "Arial";
  font-weight: 900;
  direction: ltr;
  text-align: center;
}
.receipt th{
  background-color: #fafafa;
  border-left: 2px solid #f0f0f0;
  padding-right: 15px;
}
.receipt td{
  padding-right: 20px;
}
.receipt{
  border-bottom: 1px solid #e7ebee;
}
</style>

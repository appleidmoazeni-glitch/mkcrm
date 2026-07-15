<template>
  <div>
    <div class="modal fade" id="showInv" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-xl modal-dialog-centered" role="document">
        <div class="modal-content">
          <div :class="['modal-header', invType=='sale'?'bg-danger-bright':'bg-success-bright']">
            <h5 class="modal-title">فاکتور شماره <span class="invNo"></span></h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>

          <b-skeleton-table v-if="!invLoaded" :rows="2" :columns="1" :table-props="{ bordered: true, striped: true }"></b-skeleton-table>
          <div v-else class="modal-body">

            <div class="row" v-if="invHeader">

              <div class="form-group col-lg-4 col-6">
                <label class="col-form-label">شماره فاکتور:</label>
                <div class="form-control">{{ invHeader.InvNo }}</div>
              </div>
              <div class="form-group col-lg-4 col-6">
                <label class="col-form-label">تاریخ فاکتور:</label>
                <div class="form-control">{{ new Date(invHeader.InvDate).echoFa("Y/m/d ساعت G") }}</div>
              </div>
              <div class="form-group col-lg-4">
                <label class="col-form-label">آخرین تغییر دهنده:</label>
                <div class="form-control">{{ invHeader.UserName }}</div>
              </div>

              <div class="form-group col-lg-4 col-4">
                <label class="col-form-label">کد مشتری:</label>
                <div class="form-control">{{ invHeader.AccountId }}</div>
              </div>
              <div class="form-group col-lg-4 col-8">
                <label class="col-form-label">نام مشتری:</label>
                <div class="form-control">{{ invHeader.AccountName }}</div>
              </div>
              <div class="form-group col-lg-4">
                <label class="col-form-label">رفرنس:</label>
                <div class="form-control">{{ invHeader.GeneralRef }}</div>
              </div>

              <div class="form-group col-lg-4 col-4">
                <label class="col-form-label">کد نماینده فروش:</label>
                <div class="form-control">{{ invHeader.SCode }}</div>
              </div>
              <div class="form-group col-lg-4 col-8">
                <label class="col-form-label">نام نماینده فروش:</label>
                <div class="form-control">{{ invHeader.SAccountName }}</div>
              </div>
              <div class="form-group col-lg-4">
                <label class="col-form-label">توضیح:</label>
                <div class="form-control">{{ invHeader.InvDescription }}</div>
              </div>
              <template v-if="invType=='sale'">
                <div class="form-group col-lg-4">
                  <label class="col-form-label">نام مشتری:</label>
                  <div class="form-control">{{ customerData.fullname }}</div>
                </div>
                <div class="form-group col-lg-4">
                  <label class="col-form-label">موبایل:</label>
                  <div class="form-control">{{ customerData.mobile }}</div>
                </div>
                <div class="form-group col-lg-4">
                  <label class="col-form-label">کدملی:</label>
                  <div class="form-control">{{ customerData.ncode }}</div>
                </div>
              </template>
            </div>

            <hr>

            <div class="table-responsive">
              <table class="table table-hover">
                <thead>
                <tr>
                  <th width="45"></th>
                  <th>ردیف</th>
                  <th>انبار</th>
                  <th>کد کالا</th>
                  <th>سریال</th>
                  <th>نام کالا</th>
                  <th>مقدار</th>
                  <th>فی</th>
                  <th>مبلغ</th>
                  <th>باقی مانده</th>
                </tr>
                </thead>
                <tbody>
                <tr v-for="(body, index) of invBody" :class="[body.serialheaderid?'bg-secondary':'']">
                  <td><i class="fa fa-info-circle is-big text-info" style="cursor: pointer" data-toggle="modal" :data-itemid="body.ItemId" data-target="#cardex"></i></td>
                  <td>{{index+1}}</td>
                  <td>{{body.STNumber}}</td>
                  <td>{{body.ItemCode}}</td>
                  <td>{{body.serialnumber}}</td>
                  <td>{{body.ItemDesc}}</td>
                  <td>{{body.Quan}}</td>
                  <td>{{number_format(Math.trunc(body.Price))}}</td>
                  <td>{{number_format(Math.trunc(body.Price)*body.Quan)}}</td>
                  <td></td>
                </tr>
                </tbody>
              </table>
            </div>

            <hr>

            <div class="row">
              <div class="col-lg-6 text-right d-flex align-items-end">
                <button v-if="invType=='sale'" data-toggle="modal" data-target="#showVoucherInv" class="btn btn-info mb-sm-3 mb-lg-0"><i class="fas fa-file-invoice-dollar ml-2"></i> برگه دریافت</button>
                <div class="btn-group">
                  <button class="btn btn-info d-none">قبلی</button>
                  <button class="btn btn-info d-none">بعدی</button>
                </div>
              </div>
              <div class="col-lg-6 text-left">
                <table class="table text-right">
                  <tbody>
                  <tr>
                    <td class="border-top-0" width="70">جمع:</td>
                    <td class="border-top-0">{{countOfBody}}</td>
                    <td class="border-top-0">{{number_format(sumBody)}}</td>
                  </tr>
                  <tr v-if="invHeader">
                    <td>تخفیف فاکتور:</td>
                    <td>{{ invHeader.DiscPer ? `%${invHeader.DiscPer.toFixed(2).replace('.', '/')}` : '' }}</td>
                    <td>{{ number_format(Math.trunc(invHeader.DiscAmount)) }}</td>
                  </tr>
                  <tr>
                    <td>هزینه های فاکتور:</td>
                    <td></td>
                    <td>{{number_format(sumStaticPrices)}}</td>
                  </tr>
                  <tr>
                    <td>جمع کل:</td>
                    <td></td>
                    <td>{{number_format(sumInv)}}</td>
                  </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <modal-voucher-inv :invHeader="invHeader" :sumInv="sumInv" />
    <modal-cardex />
  </div>
</template>

<script>
import axios from "axios";
import util from "../assets/pureFunctions";
import ModalVoucherInv from "./ModalVoucherInv";
import ModalCardex from "./ModalCardex";

export default {
  data(){
    return {
      invHeader: [],
      customerData: {
        fullname: "",
        mobile: "",
        ncode: ""
      },
      invBody: [],
      sumBody: 0,
      invStaticPrices: [],
      sumStaticPrices: 0,
      sumInv: 0,
      countOfBody: 0,
      invLoaded: false,
      number_format: util.number_format,
    }
  },
  props: ['invHeaders', 'invType'],
  methods: {
    invCalc(){
      this.sumBody = 0;
      this.sumStaticPrices = 0;
      this.sumInv = 0;
      this.countOfBody = 0;

      for(let i of this.invBody){
        this.sumBody += Math.trunc(i.Price * i.Quan);
        this.countOfBody += i.Quan;
      }

      for(let i of this.invStaticPrices){
        this.sumStaticPrices += Math.trunc(i.InvExpRowAmount);
      }

      this.sumInv = this.sumBody + this.sumStaticPrices - Math.trunc(this.invHeader.DiscAmount);

      this.invLoaded = true;
    },
    showInvoice(invNo, headerId, invType=""){
      let fullLoadData = 0;
      this.invLoaded = false;

      invType = invType ? invType : this.invType;

      axios.post('https://shygun.4mk.ir/api/invHeader/get', {no: invNo, type: invType=='sale'?2:3}).then(({data}) => {
        if( data && data.ok ){
          this.customerData = {
            fullname: "",
            mobile: "",
            ncode: ""
          }

          this.invHeader = data.list[0];

          if( invType=='sale' && this.invHeader.InvDescription && (this.invHeader.InvDescription.indexOf('||') != -1 || this.invHeader.InvDescription.indexOf('ك.م:') != -1 || this.invHeader.InvDescription.indexOf('نام:') != -1 || this.invHeader.InvDescription.indexOf('تل:') != -1) ){
            let datalist = [this.invHeader.InvDescription, ""];
            if( this.invHeader.InvDescription.indexOf('||') != -1 ){
              datalist = this.invHeader.InvDescription.split('||');
            }
            this.invHeader.InvDescription = datalist[1];

            for(let i of datalist[0].split(' ,')){
              let item = i.split(':');
              switch (item[0]){
                case 'نام': this.customerData.fullname = item[1]; break;
                case 'تل': this.customerData.mobile = item[1]; break;
                case 'ك.م': this.customerData.ncode = item[1]; break;
              }
            }
          }

          if( ++fullLoadData == 3 ){
            this.invCalc();
          }
        }else{
          toastr['error']("خطا در هدر فاکتور");
        }
      });
      axios.post('https://shygun.4mk.ir/api/invBody/get', {id: headerId}).then(({data}) => {
        if( data && data.ok ){
          this.invBody = data.list;
          if( ++fullLoadData == 3 ){
            this.invCalc();
          }
        }else{
          toastr['error']("خطا در بادی فاکتور");
        }
      });
      axios.post('https://shygun.4mk.ir/api/invStaticPrices/get', {id: headerId}).then(({data}) => {
        if( data && data.ok ){
          this.invStaticPrices = data.list;
          if( ++fullLoadData == 3 ){
            this.invCalc();
          }
        }else{
          toastr['error']("خطا در هزینه های ثابت فاکتور");
        }
      });
    }
  },
  mounted() {
    const vm = this;
    $(document).ready(function () {
      $('#showInv').on('show.bs.modal', function (event) {
        var el = $(event.relatedTarget), modal = $(this), i = el.data('index');
        modal.find('.invNo').text(vm.invHeaders[i].InvNo);
        var invtype = el.data('invtype') ? el.data('invtype') : "";
        vm.showInvoice(vm.invHeaders[i].InvNo, vm.invHeaders[i].InvHeaderId, invtype);
      });
    });
  },
  components: {
    'modal-voucher-inv' : ModalVoucherInv,
    'modal-cardex': ModalCardex
  }
}
</script>
